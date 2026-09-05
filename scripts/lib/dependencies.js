'use strict';

function dependencyIds(item) {
  if (!Array.isArray(item?.dependsOn)) return [];
  return [...new Set(item.dependsOn.filter((id) => typeof id === 'string' && id.length > 0))];
}

function dependencyIsComplete(item) {
  return item?.kind === 'feature' ? item.status === 'shipped' : item?.kind === 'bug' && item.status === 'closed';
}

function indexWorkItems(items) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function unmetDependencyIds(item, itemsById) {
  return dependencyIds(item).filter((id) => !dependencyIsComplete(itemsById.get(id)));
}

function filterDependencyEligibleCandidates(candidates, itemsById) {
  return candidates.filter((candidate) => unmetDependencyIds(candidate, itemsById).length === 0);
}

module.exports = {
  dependencyIds,
  dependencyIsComplete,
  filterDependencyEligibleCandidates,
  indexWorkItems,
  unmetDependencyIds,
};
