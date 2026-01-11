export function generateAntiCheat(): { question: string; answer_int: number } {
  // Keep it very simple for MVP (no negative answers)
  const a = 2 + Math.floor(Math.random() * 8); // 2..9
  const b = 1 + Math.floor(Math.random() * 9); // 1..9
  const op = Math.random() < 0.5 ? "+" : "-";
  if (op === "+") return { question: `Сколько будет ${a} + ${b}?`, answer_int: a + b };
  const max = Math.max(a, b);
  const min = Math.min(a, b);
  return { question: `Сколько будет ${max} - ${min}?`, answer_int: max - min };
}


