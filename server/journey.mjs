// A reworded finding in the same rule and field remains unresolved.
export function compareFindings(before, after) {
  const unmatched = new Set(after.map((_, index) => index));
  const matchedBefore = new Set(), matchedAfter = new Set();
  function match(oldIndex, index) { matchedBefore.add(oldIndex); matchedAfter.add(index); unmatched.delete(index); }
  before.forEach((old, oldIndex) => {
    const index = [...unmatched].find(index => after[index].issue_id === old.issue_id);
    if (index !== undefined) match(oldIndex, index);
  });
  before.forEach((old, oldIndex) => {
    if (matchedBefore.has(oldIndex)) return;
    const index = [...unmatched].find(index => after[index].rule_id === old.rule_id && after[index].field_path === old.field_path);
    if (index !== undefined) match(oldIndex, index);
  });
  return { resolved: before.filter((_, index) => !matchedBefore.has(index)), remaining: after.filter((_, index) => matchedAfter.has(index)), added: [...unmatched].map(index => after[index]) };
}
