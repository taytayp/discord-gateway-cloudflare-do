const CLEF_MODEL = "@cf/cloudflare/clef-flash";

const QUESTIONS = {
  cursing: {
    type: "noul",
    instructions: "Does this message contain cursing, swearing, or vulgar language?",
  }
} as const;

export async function judgeMessage(ai: Ai, text: string) {
  // Generated Workers types don't know Clef yet.
  return (await ai.run(CLEF_MODEL, {
    model: "clef-flash",
    state: text.slice(0, 2000),
    questions: QUESTIONS,
  })) as {
    answers: {
      cursing: { noul: number };
    };
    usage?: { input_tokens?: number; output_tokens?: number };
  };
}
