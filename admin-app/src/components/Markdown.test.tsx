import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import Markdown from './Markdown'

const agentNote = `### Release plan
1. Build the admin
   - Keep the nested check
2. Verify FR-12

\`\`\`sh
npm test
\`\`\`

| Surface | State |
| --- | --- |
| Hosting | Ready |

See https://example.com/release.
Next line stays separate.`

describe('Markdown', () => {
  it('snapshots a representative agent note with GFM and hard line breaks', () => {
    const { container } = render(<Markdown source={agentNote} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders raw HTML as inert text instead of live elements', () => {
    const source = 'Keep <script>alert("unsafe")</script> and <img src=x onerror="alert(1)"> visible.'
    const { container } = render(<Markdown source={source} />)

    expect(container).toHaveTextContent('<script>alert("unsafe")</script>')
    expect(container).toHaveTextContent('<img src=x onerror="alert(1)">')
    expect(container.querySelector('script')).not.toBeInTheDocument()
    expect(container.querySelector('img')).not.toBeInTheDocument()
  })

  it('offers text and link hooks without rewriting code content', () => {
    const renderText = (text: string) => text === 'Open FR-12' ? <button>Open FR-12</button> : text
    const { container, getByRole } = render(<Markdown source={'Open FR-12\n\n`FR-12`\n\n[Details](/admin/features?item=FR-12)'} renderText={renderText} renderLink={({ href, children }) => <a data-route={href}>{children}</a>} />)

    expect(getByRole('button', { name: 'Open FR-12' })).toBeInTheDocument()
    expect(container.querySelector('code')).toHaveTextContent('FR-12')
    expect(container.querySelector('a[data-route="/admin/features?item=FR-12"]')).toHaveTextContent('Details')
  })
})
