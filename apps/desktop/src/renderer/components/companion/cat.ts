/**
 * MarCat companion — the ASCII cat that fronts the AI.
 *
 * Phrases are template-based (NO LLM calls): the mascot stays cheap. A deterministic
 * trigger→reaction engine maps events to a (mood, phrase) with rotating variants and
 * {placeholder} interpolation. AI-authored lines only piggyback on a running AI request.
 */
export type Mood =
  | 'sleeping'
  | 'idle'
  | 'happy'
  | 'excited'
  | 'thinking'
  | 'worried'
  | 'alarmed'
  | 'proud'
  | 'curious'
  | 'hunting'
  | 'hungry'
  | 'content'

type Lang = 'en' | 'ru'

export interface CompanionFace {
  face: string
  /** Tailwind text color token class for the face. */
  tone: string
}

// The cat is the signature orange almost always; only genuine alert states recolor it.
export const FACES: Record<Mood, CompanionFace> = {
  sleeping: { face: '=^-﹏-^=', tone: 'text-accent' },
  idle: { face: '=^•‿•^=', tone: 'text-accent' },
  happy: { face: '=^◡^=', tone: 'text-accent' },
  excited: { face: '=^*ω*^=', tone: 'text-accent' },
  thinking: { face: '=^·.·^=', tone: 'text-accent' },
  worried: { face: '=^;_;^=', tone: 'text-warning' },
  alarmed: { face: '=>x_x<=', tone: 'text-alarm' },
  proud: { face: '=^ᵔ◡ᵔ^=', tone: 'text-accent' },
  curious: { face: '=^•.•^=', tone: 'text-accent' },
  hunting: { face: '=^o.O^=', tone: 'text-accent' },
  hungry: { face: '=^·﹏·^=', tone: 'text-accent' },
  content: { face: '=^⌒‿⌒^=', tone: 'text-accent' },
}

const CALM = new Set<Mood>(['idle', 'happy', 'excited', 'proud', 'curious', 'content'])
const BLINK = '=^-‿-^='

/** Face to render — calm moods briefly close their eyes when `blinking`. */
export function faceFor(mood: Mood, blinking: boolean): string {
  return blinking && CALM.has(mood) ? BLINK : FACES[mood].face
}

/** Semantic events the rest of the app fires at the cat. */
export type Trigger =
  | 'idle'
  | 'working'
  | 'proposalReady'
  | 'aiError'
  | 'wishlistsUp'
  | 'onTrack'
  | 'deadlineNear'
  | 'overdue'
  | 'milestoneRisk'
  | 'taskDone'
  | 'synced'
  | 'levelUp'
  | 'creatorReplied'
  | 'outreachDue'
  | 'creatorPublished'

interface Reaction {
  mood: Mood
  phrases: Record<Lang, string[]>
}

const TRIGGERS: Record<Trigger, Reaction> = {
  idle: {
    mood: 'idle',
    phrases: {
      en: ['Idle paws… poke me?', 'Ready when you are.', 'What shall we plan?'],
      ru: ['Лапки скучают… тыкни?', 'Готов, как скажешь.', 'Что планируем?'],
    },
  },
  working: {
    mood: 'thinking',
    phrases: {
      en: ['Mrr… thinking…', 'Pulling the context together…', 'Drafting a plan…'],
      ru: ['Мур… думаю…', 'Собираю контекст…', 'Готовлю план…'],
    },
  },
  proposalReady: {
    mood: 'proud',
    phrases: {
      en: ['Done — take a look.', 'Proposal ready for review.', 'Fetched you a plan.'],
      ru: ['Готово — глянь.', 'Предложение готово к ревью.', 'Принёс тебе план.'],
    },
  },
  aiError: {
    mood: 'worried',
    phrases: {
      en: ['Hmm, that went sideways.', 'I hit a snag — see the error.'],
      ru: ['Хм, что-то пошло не так.', 'Споткнулся — глянь ошибку.'],
    },
  },
  wishlistsUp: {
    mood: 'excited',
    phrases: {
      en: ['Wishlists +{n} — nom nom!', 'That landed! +{n} wishlists.', 'Mrrrow, growth!'],
      ru: ['Вишлисты +{n} — ням-ням!', 'Сработало! +{n} вишлистов.', 'Мрррр, рост!'],
    },
  },
  onTrack: {
    mood: 'happy',
    phrases: {
      en: ['On track. Nice.', 'Looking good.', 'Steady as she goes.'],
      ru: ['Всё по плану, мур.', 'Выглядит хорошо.', 'Идём ровно.'],
    },
  },
  deadlineNear: {
    mood: 'worried',
    phrases: {
      en: ['“{name}” in {d}d — tail twitching.', '{d} days to “{name}”…'],
      ru: ['«{name}» через {d} дн. — хвост дёргается.', '{d} дн. до «{name}»…'],
    },
  },
  overdue: {
    mood: 'worried',
    phrases: {
      en: ['{n} task(s) overdue…', 'We slipped on {n} task(s).'],
      ru: ['Просрочено задач: {n}…', 'Профукали {n} задач(и).'],
    },
  },
  milestoneRisk: {
    mood: 'alarmed',
    phrases: {
      en: ['“{name}” is at risk!', 'Deadline slipping — feed me wishlists!'],
      ru: ['«{name}» под угрозой!', 'Срок плывёт — корми вишлистами!'],
    },
  },
  taskDone: {
    mood: 'proud',
    phrases: {
      en: ['Checked off. Nice.', 'One down!'],
      ru: ['Готово, вычёркиваю.', 'Минус задача!'],
    },
  },
  synced: {
    mood: 'excited',
    phrases: {
      en: ['Pulled in {n} fresh item(s).', 'Synced — {n} new.'],
      ru: ['Подтянул {n} свежих.', 'Синк готов — {n} новых.'],
    },
  },
  levelUp: {
    mood: 'excited',
    phrases: {
      en: ['Level up — Lv {level}!', 'We hit Lv {level}!', 'Ding! Lv {level}.'],
      ru: ['Левел-ап — ур. {level}!', 'Доросли до ур. {level}!', 'Дзынь! Ур. {level}.'],
    },
  },
  creatorReplied: {
    mood: 'excited',
    phrases: {
      en: ['“{name}” replied — mrrow!', '{name} wrote back!', 'A reply from {name}!'],
      ru: ['«{name}» ответил — мрряу!', '{name} написал в ответ!', 'Ответ от {name}!'],
    },
  },
  outreachDue: {
    mood: 'worried',
    phrases: {
      en: ['{n} creator(s) awaiting a follow-up…', 'Time to nudge {n} contact(s).'],
      ru: ['Ждут фоллоу-апа: {n}…', 'Пора пнуть {n} контакт(ов).'],
    },
  },
  creatorPublished: {
    mood: 'proud',
    phrases: {
      en: ['“{name}” went live — mark the beat!', '{name} published! Log it as a beat.'],
      ru: ['«{name}» вышел — отметь бит!', '{name} опубликовал! Запиши как бит.'],
    },
  },
}

/** Resolve a trigger into a mood + an interpolated, rotating phrase. */
export function resolveReaction(
  trigger: Trigger,
  lang: Lang,
  seed: number,
  ctx?: Record<string, string | number>,
): { mood: Mood; message: string } {
  const def = TRIGGERS[trigger]
  const list = def.phrases[lang] ?? def.phrases.en
  const raw = list[Math.abs(seed) % list.length] ?? ''
  const message = raw.replace(/\{(\w+)\}/g, (_, k: string) => String(ctx?.[k] ?? ''))
  return { mood: def.mood, message }
}

// Eyes are exactly 3 chars wide so the face line stays aligned across moods.
const EYES: Record<Mood, string> = {
  sleeping: '-.-',
  idle: 'o.o',
  happy: '^.^',
  excited: '*.*',
  thinking: 'o.O',
  worried: ';.;',
  alarmed: 'x.x',
  proud: '^.^',
  curious: 'o.o',
  hunting: 'o.O',
  hungry: '·.·',
  content: '^.^',
}

/** Clean, monospace-aligned cat for the AI "den" page. */
export function bigCat(mood: Mood): string {
  const z = mood === 'sleeping' ? '  z z' : ''
  return [' /\\_/\\', `( ${EYES[mood]} )${z}`, ' > ^ <'].join('\n')
}
