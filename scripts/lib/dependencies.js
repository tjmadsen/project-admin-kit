'use strict';

const { kindById, loadWorkKinds } = require('./work-kinds');

function dependencyIds(item) {
  if (!Array.isArray(item?.dependsOn)) return [];
  return [...new Set(item.dependsOn.filter((id) => typeof id === 'string' && id.length > 0))];
}

// A prerequisite is satisfied only by its kind's done status (shipped, closed);
// declined work and unknown kinds never unblock a dependent.
function dependencyIsComplete(item, kinds = loadWorkKinds()) {
  const kind = kindById(kinds, item?.kind);
  return Boolean(kind) && item.status === kind.statuses.done;
}

function indexWorkItems(items) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function unmetDependencyIds(item, itemsById, kinds) {
  return dependencyIds(item).filter((id) => !dependencyIsComplete(itemsById.get(id), kinds));
}

function filterDependencyEligibleCandidates(candidates, itemsById, kinds) {
  return candidates.filter((candidate) => unmetDependencyIds(candidate, itemsById, kinds).length === 0);
}

module.exports = {
  dependencyIds,
  dependencyIsComplete,
  filterDependencyEligibleCandidates,
  indexWorkItems,
  unmetDependencyIds,
};
