function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

export function validateQuiz(input) {
  if (!input.title?.trim() || input.title.trim().length < 2) invalid('Введите название квиза');
  if (!input.category?.trim()) invalid('Введите категорию');
  if (!Array.isArray(input.questions) || !input.questions.length) invalid('Добавьте хотя бы один вопрос');

  for (const question of input.questions) {
    if (!question.text?.trim()) invalid('Заполните текст каждого вопроса');
    if (!['SINGLE', 'MULTIPLE'].includes(question.type)) invalid('Выберите тип ответа');
    if (!Array.isArray(question.options) || question.options.length < 2 || question.options.some((option) => !option.text?.trim())) {
      invalid('Заполните варианты ответа');
    }

    const correctCount = question.options.filter((option) => option.correct).length;
    if (!correctCount || (question.type === 'SINGLE' && correctCount !== 1)) invalid('Проверьте правильные ответы');

    question.duration = Math.min(120, Math.max(5, Number(question.duration) || 20));
    question.points = Math.min(100, Math.max(0.1, Number(question.points) || 1));
  }
}

