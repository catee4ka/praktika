export function isCorrectAnswer(question, selectedIds) {
  const correct = question.options.filter((option) => option.correct).map((option) => option.id).sort();
  const selected = [...new Set(selectedIds)].sort();
  return correct.length === selected.length && correct.every((id, index) => id === selected[index]);
}

export function calculateScore({ question, selectedIds }) {
  const points = Number(question.points ?? 1);
  if (question.type !== 'MULTIPLE') return isCorrectAnswer(question, selectedIds) ? points : 0;

  const correctIds = new Set(question.options.filter((option) => option.correct).map((option) => option.id));
  const part = points / correctIds.size;
  const score = [...new Set(selectedIds)].reduce((total, optionId) => total + (correctIds.has(optionId) ? part : -part), 0);
  return Math.round(score * 100) / 100;
}
