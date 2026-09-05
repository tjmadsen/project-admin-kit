import { Fragment, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

type SyntaxNode = {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: SyntaxNode[]
}

export type MarkdownLinkRenderer = (link: { href: string; children: ReactNode; external: boolean }) => ReactNode
export type MarkdownTextRenderer = (text: string) => ReactNode

type MarkdownProps = {
  source: string
  className?: string
  renderLink?: MarkdownLinkRenderer
  renderText?: MarkdownTextRenderer
}

// react-markdown's skipHtml drops source HTML. Convert those syntax nodes to
// text first so suspicious input stays visible for review without becoming DOM.
function preserveRawHtmlAsText() {
  return (tree: SyntaxNode) => {
    const visit = (node: SyntaxNode) => {
      node.children?.forEach((child, index) => {
        if (child.type === 'html') node.children![index] = { type: 'text', value: child.value || '' }
        else visit(child)
      })
    }
    visit(tree)
  }
}

// A future reference-linker can supply renderText without needing to fork the
// Markdown pipeline. Links and code are excluded so their contents stay intact.
function exposeTextNodes() {
  return (tree: SyntaxNode) => {
    const visit = (node: SyntaxNode, excluded = false) => {
      const isExcluded = excluded || (node.type === 'element' && ['a', 'code', 'pre'].includes(node.tagName || ''))
      if (!node.children || isExcluded) return
      node.children = node.children.map((child) => {
        if (child.type === 'text') {
          return {
            type: 'element',
            tagName: 'span',
            properties: { 'data-markdown-text': true },
            children: [child],
          }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

export default function Markdown({ source, className = '', renderLink, renderText }: MarkdownProps) {
  const components: Components = {
    a: ({ node: _node, href = '', children, ...props }) => {
      const external = /^https?:\/\//i.test(href)
      if (renderLink) return <Fragment>{renderLink({ href, children, external })}</Fragment>
      return <a {...props} className="work-item-link" href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a>
    },
    span: ({ node: _node, children, ...props }) => {
      const isExposedText = Boolean((props as Record<string, unknown>)['data-markdown-text'])
      if (isExposedText && renderText) return <Fragment>{renderText(String(children ?? ''))}</Fragment>
      return <span {...props}>{children}</span>
    },
  }

  return <div className={`markdown ${className}`.trim()}>
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm, remarkBreaks, preserveRawHtmlAsText]}
      rehypePlugins={renderText ? [exposeTextNodes] : undefined}
      components={components}
    >
      {source}
    </ReactMarkdown>
  </div>
}
