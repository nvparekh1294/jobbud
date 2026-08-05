// Shared anti-AI writing rules.
//
// Every generation path (outreach messages, coach story drafts, interview prep
// docs, application packages) used to carry its own copy of these bans, and the
// copies had drifted: outreach banned 18 words, coach banned 7, and the resume
// prompt banned no vocabulary at all. This module is the single source of truth
// so a rule added here reaches all four call sites at once.
//
// STRICTLY GENERIC by design: nothing about any specific person, employer,
// metric, or personal habit belongs in this file. Person-specific guidance stays
// inline at the call site that needs it.

export const ANTI_AI_WRITING_RULES = `VOICE:
- Direct and specific. Short sentences. Vary the rhythm so it never sounds mechanical.
- Use contractions: I'm, don't, it's, you're. Active voice.
- Confident, not eager. Never desperate, never flattering.
- Concrete beats abstract. If a claim cannot be backed by something real, cut it rather than dressing it up.

BANNED WORDS — never use:
leverage, synergy, innovative, align, foster, showcase, enhance, streamline, elevate, empower, transformative, seamless, robust, dynamic, pivotal, crucial, underscore, highlight, accelerate, pioneering, holistic.

BANNED PHRASES — never use:
"serves as", "stands as", "represents a", "plays a role in", "helps to", "aims to", "seeks to", "Furthermore", "Additionally", "Moreover", "That said", "With that in mind", "I hope this message finds you well", "I wanted to reach out", "I am very passionate about", "would love to connect".

BANNED FORMATTING:
- No em dashes. Use semicolons, colons, commas, or periods instead.
- No double dashes ( -- ) either. Restructure the sentence.
- No sentence that announces what the text is about to do ("I'm writing to", "I wanted to introduce myself", "Quick note to").
- Do not use three parallel items. If one thing is the point, say one thing.`;

export default ANTI_AI_WRITING_RULES;
