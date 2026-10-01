import type { CSSProperties } from 'react';
import { Fill, asset, ease, progress, type SceneProps, type SceneSounds } from 'storyboard';
import { Headline, type WordState } from '../components/Headline';
import { LOOKS, PromptCard, type LayerName } from '../components/PromptCard';
import { BG, CARD, HEADLINE_SIZE, HEADLINE_TOP, INK, MONO, PINK } from '../components/tokens';

type Token = [text: string, color: string, weight?: number];

const P = '#a1a1aa'; // punctuation
const A = '#71717a'; // attributes
const T = '#52525b'; // text content

const CODE: Token[][] = [
  [
    ['<', P],
    ['Card', INK, 600],
    ['>', P],
  ],
  [
    ['  <', P],
    ['Header', INK, 600],
    [' title', A],
    ['=', P],
    ['"Anatomy"', PINK],
    [' duration', A],
    ['={', P],
    ['3.32', PINK],
    ['} />', P],
  ],
  [
    ['  <', P],
    ['Prompt', INK, 600],
    ['>', P],
  ],
  [['    Hold on the headline a full second…', T]],
  [
    ['  </', P],
    ['Prompt', INK, 600],
    ['>', P],
  ],
  [
    ['  <', P],
    ['Actions', INK, 600],
    [' send cancel', A],
    [' />', P],
  ],
  [
    ['</', P],
    ['Card', INK, 600],
    ['>', P],
  ],
];
const TOTAL_CHARS = CODE.reduce((n, line) => n + line.reduce((m, [text]) => m + text.length, 0), 0);

const WORDS = ['de ijsbaan', 'gaat', 'weer', 'open'];
const BIG = 150;

/** Moments shared by the animation and the sound cues. */
const WORD_AT = (i: number) => 0.15 + i * 0.09;
const TYPE_START = 2.35;
const TYPE_END = 3.15;
const COMPILE_AT = 3.27;
const KEY_EVERY = 0.068;

export const sounds: SceneSounds = [
  ...WORDS.map((_, i) => ({ at: WORD_AT(i), sound: 'tick', pitch: i * 2 - 3, volume: 0.45 })),
  ...Array.from({ length: Math.floor((TYPE_END - TYPE_START) / KEY_EVERY) }, (_, i) => ({
    at: TYPE_START + i * KEY_EVERY,
    sound: `key-${(i % 4) + 1}`,
    pitch: ((i * 7) % 3) - 1,
    volume: 0.4 + ((i * 5) % 4) * 0.05,
  })),
  { at: COMPILE_AT, sound: 'pop', volume: 0.7 },
  { at: COMPILE_AT, sound: 'sparkle', volume: 0.55 },
];

function CodeLines({ visible, fade }: { visible: number; fade: number }) {
  let budget = Math.floor(visible);
  let caretPlaced = false;
  return (
    <div
      style={{
        position: 'absolute',
        left: CARD.x + 44,
        top: CARD.y + 60,
        fontFamily: MONO,
        fontSize: 19,
        lineHeight: '31px',
        whiteSpace: 'pre',
        opacity: fade,
        transform: fade < 1 ? `translateY(${(1 - fade) * -10}px)` : undefined,
        filter: fade < 1 ? `blur(${(1 - fade) * 3}px)` : undefined,
      }}
    >
      {CODE.map((line, li) => {
        const parts = line.map(([text, color, weight], ti) => {
          const shown = text.slice(0, Math.max(0, budget));
          budget -= text.length;
          return (
            <span key={ti} style={{ color, fontWeight: weight ?? 400 }}>
              {shown}
            </span>
          );
        });
        const caretHere = !caretPlaced && budget < 0;
        if (caretHere) caretPlaced = true;
        const typing = visible < TOTAL_CHARS;
        return (
          <div key={li} style={{ height: 31 }}>
            {parts}
            {caretHere && typing && (
              <span
                style={{ display: 'inline-block', width: 2, height: 22, marginLeft: 1, verticalAlign: -4, background: PINK }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Intro({ t }: SceneProps) {
  // 1. Words rise in, big and centred.
  const words: WordState[] = WORDS.map((text, i) => {
    const start = WORD_AT(i);
    const arrive = progress(t, start, start + 0.8, ease.outExpo);
    return { text, open: 1, shift: 0.42 * (1 - arrive), fade: progress(t, start, start + 0.4) };
  });

  // 2. The line shrinks up into the shared headline position.
  const lift = progress(t, 1.7, 2.5, ease.smooth);
  const scale = 1 + (BIG / HEADLINE_SIZE - 1) * (1 - lift);
  const dropY = 540 - (HEADLINE_TOP + HEADLINE_SIZE / 2);
  const headlineStyle: CSSProperties | undefined =
    lift < 1 ? { transform: `translateY(${dropY * (1 - lift)}px) scale(${scale})`, transformOrigin: '50% 50%' } : undefined;

  // 3. A code panel arrives and types itself …
  const panel = progress(t, 2.1, 2.7, ease.outExpo);
  const typedChars = progress(t, TYPE_START, TYPE_END) * TOTAL_CHARS;
  // 4. … then compiles into the real card.
  const codeFade = 1 - progress(t, TYPE_END - 0.05, COMPILE_AT + 0.03, ease.outCubic);
  const order: LayerName[] = ['header', 'inset', 'text', 'footer', 'send'];
  const layer = (name: LayerName): CSSProperties | undefined => {
    if (name === 'surface') return undefined;
    const start = COMPILE_AT + order.indexOf(name) * 0.05;
    const p = progress(t, start, start + 0.45, ease.outExpo);
    if (p >= 1) return undefined;
    return { opacity: p, transform: `translateY(${(1 - p) * 12}px)` };
  };
  const cardStyle: CSSProperties =
    panel < 1
      ? { left: CARD.x, top: CARD.y, opacity: panel, transform: `translateY(${(1 - panel) * 36}px)` }
      : { left: CARD.x, top: CARD.y };

  return (
    <Fill style={{ background: BG }}>
      <img src={asset('bg-ijch.jpg')} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      {panel > 0 && <PromptCard look={LOOKS.inset} layer={layer} style={cardStyle} />}
      {panel > 0 && codeFade > 0 && typedChars > 0 && <CodeLines visible={typedChars} fade={codeFade} />}
      <Headline words={words} style={headlineStyle} />
    </Fill>
  );
}
