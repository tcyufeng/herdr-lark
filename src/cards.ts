import type { AskOption, AskPayload, Lang, NotifyPayload } from './validate.js';

export type AskState = 'pending' | 'answered' | 'timedout' | 'cancelled';

const TEXTS = {
  zh: {
    doing: '在做',
    background: '背景',
    blocker: '卡点',
    options: '选项',
    recommend: '我的判断',
    question: '你的判断',
    recommended: '← 我推荐',
    yourReply: '你的回复',
    theQuestion: '（原问题）',
    hint: '想说别的？直接在本群发消息就行，第一条消息就是答复。',
    hintDanger: '红色按钮会二次确认；也可以直接在群里打字。',
    answered: '已回答',
    timedout: '已超时',
    cancelled: '已取消',
    confirmTitle: '确认执行',
    confirmText: (label: string) => `“${label}”是不可逆或高代价的操作。确定选它？`,
    notDelivered: '没能送达',
    notDeliveredBody: (why: string) => `刚才那条消息没能送进终端：${why}`,
    statusBlocked: '等你输入',
    statusIdle: '干完了',
    linkDown: '收不到你的消息了',
    linkBack: '连接恢复了',
  },
  en: {
    doing: 'Doing',
    background: 'Background',
    blocker: 'Blocker',
    options: 'Options',
    recommend: 'My recommendation',
    question: 'Your call',
    recommended: '← recommended',
    yourReply: 'Your reply',
    theQuestion: '(the question as asked)',
    hint: 'Want to say something else? Just send a message in this group — the first one is the answer.',
    hintDanger: 'Red buttons ask for confirmation; you can also just type here.',
    answered: 'Answered',
    timedout: 'Timed out',
    cancelled: 'Cancelled',
    confirmTitle: 'Confirm',
    confirmText: (label: string) => `"${label}" is irreversible or high-cost. Go ahead?`,
    notDelivered: 'Not delivered',
    notDeliveredBody: (why: string) => `That message never reached the terminal: ${why}`,
    statusBlocked: 'waiting for you',
    statusIdle: 'finished',
    linkDown: 'not receiving your messages',
    linkBack: 'connection restored',
  },
} as const;

export const t = (lang: Lang = 'zh') => TEXTS[lang];

/**
 * Card JSON 2.0. The `markdown` element is a real rich-text component —
 * tables, ordered/unordered lists and fenced code blocks all render — unlike
 * 1.0's `lark_md`, which is only an *inline* formatting tag on a text
 * component and supports none of them. The one breaking change from 1.0:
 * `tag: "action"` is gone, buttons sit directly in `body.elements`.
 */
const md = (content: string): object => ({ tag: 'markdown', content });
const hr = (): object => ({ tag: 'hr' });

/**
 * Small grey caption line. Colour is an inline `<font>` tag in the content:
 * the markdown element has `text_size` and `text_align`, but no `text_color`.
 */
const note = (content: string): object => ({
  tag: 'markdown',
  content: `<font color='grey'>${content}</font>`,
  text_size: 'notation',
});

function card(header: { icon: string; title: string; template: string }, elements: object[]): object {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: `${header.icon} ${header.title}` },
      template: header.template,
    },
    body: { elements },
  };
}

function field(label: string, value: string): string {
  return `**${label}**　${value}`;
}

function optionLines(options: AskOption[], recommend: string, lang: Lang): string {
  const T = t(lang);
  return options
    .map((o, i) => {
      const flag = o.id === recommend ? `　${T.recommended}` : o.danger ? '　⚠️' : '';
      return `${i + 1}. **${o.label}**${flag}\n   ${o.consequence}`;
    })
    .join('\n');
}

export interface AskCardContext {
  payload: AskPayload;
  projectLabel: string;
  reqId: string;
  state: AskState;
  reply?: string;
}

const HEADER: Record<AskState, { template: string; icon: string }> = {
  pending: { template: 'blue', icon: '🤔' },
  answered: { template: 'green', icon: '✅' },
  timedout: { template: 'grey', icon: '⌛' },
  cancelled: { template: 'grey', icon: '⚠️' },
};

export function askCard(ctx: AskCardContext): object {
  const { payload: p, state } = ctx;
  const lang = p.lang ?? 'zh';
  const T = t(lang);
  const head = HEADER[state];
  const statusWord =
    state === 'answered' ? T.answered : state === 'timedout' ? T.timedout : state === 'cancelled' ? T.cancelled : '';

  const elements: object[] = [];
  if (state === 'answered' && ctx.reply) {
    elements.push(md(field(T.yourReply, ctx.reply)), hr(), note(T.theQuestion));
  }

  elements.push(
    md(field(T.doing, p.doing)),
    md(field(T.background, p.description)),
    md(field(T.blocker, p.blocker)),
    hr(),
    md(`**${T.options}**\n\n${optionLines(p.options, p.recommend, lang)}`),
    hr(),
    md(field(T.recommend, p.reasoning)),
    md(`**${T.question}**　${p.question}`),
  );

  // A closed card ends with its outcome, where the buttons used to be. The
  // "your reply" line at the top is only seen by someone reading from the
  // start; after a tap the eye is at the bottom, and a card that merely loses
  // its buttons reads as if the choice went nowhere.
  if (state !== 'pending') {
    elements.push(
      hr(),
      state === 'answered' && ctx.reply
        ? md(`✅ **${T.yourReply}**　${ctx.reply}`)
        : note(state === 'timedout' ? `⌛ ${T.timedout}` : `⚠️ ${T.cancelled}`),
    );
  }

  if (state === 'pending') {
    for (const o of p.options) {
      const button: Record<string, unknown> = {
        tag: 'button',
        text: { tag: 'plain_text', content: o.label },
        type: o.danger ? 'danger' : o.id === p.recommend ? 'primary' : 'default',
        // Both the 1.0 `value` field and 2.0 `behaviors` reach the callback as
        // `action.value`; `value` is kept because it is the shorter of the two
        // and was verified to work on a schema-2.0 card.
        value: { reqId: ctx.reqId, optionId: o.id },
      };
      if (o.danger) {
        button.confirm = {
          title: { tag: 'plain_text', content: T.confirmTitle },
          text: { tag: 'plain_text', content: T.confirmText(o.label) },
        };
      }
      elements.push(button);
    }
    elements.push(note(p.options.some((o) => o.danger) ? T.hintDanger : T.hint));
  }

  return card(
    { icon: head.icon, title: `[${ctx.projectLabel}] ${p.title}${statusWord ? ` · ${statusWord}` : ''}`, template: head.template },
    elements,
  );
}

/** A conversational reply: the terminal answer, mirrored verbatim. */
/**
 * Whether the session that sent this reply is still mid-turn. A `say` card is
 * a snapshot, but "is it my turn to answer" is a fact that changes after the
 * card is sent — so the card carries the answer and the daemon rewrites it.
 */
export type TurnState = 'running' | 'done' | 'blocked' | 'superseded';

const TURN_FOOTER: Record<TurnState, string> = {
  running: "<font color='grey'>⏳ 还在跑，这条不一定是结论</font>",
  done: "<font color='green'>✅ 说完了，轮到你</font>",
  blocked: "<font color='orange'>⚠️ 卡在终端里一个只有你能点的确认框上</font>",
  // Any card but the newest. Its own state is history and saying "over to you"
  // on a card that has already been answered by a later one is a lie.
  superseded: "<font color='grey'>↓ 这条之后还有新的</font>",
};

export function sayCard(body: string, projectLabel: string, title?: string, state: TurnState = 'running'): object {
  return card({ icon: '💬', title: title?.trim() || `[${projectLabel}]`, template: 'turquoise' }, [
    md(body),
    { tag: 'markdown', content: TURN_FOOTER[state], text_size: 'notation' },
  ]);
}

export function notifyCard(p: NotifyPayload, projectLabel: string): object {
  return card({ icon: '📣', title: `[${projectLabel}] ${p.title}`, template: 'wathet' }, [md(p.body)]);
}

/**
 * A turn ended and the session never mirrored a word of it. The rule that
 * every reply goes to the group is the agent's to follow, and an agent that
 * forgets fails silently — the human just sits there. An earlier version told
 * the *agent* by injecting a reminder into the pane, which interrupted the
 * very conversation it was protecting. This tells the *human* instead, on the
 * device they are actually holding, and carries the terminal's own output so
 * the card is worth something on its own.
 */
export function missedMirrorCard(
  projectLabel: string,
  task: string | null,
  text: string | null,
  source: 'transcript' | 'terminal' = 'terminal',
): object {
  const head = task ? `**${task}**\n\n` : '';
  // From the transcript it is the agent's own markdown and renders properly.
  // Scraped off the terminal it is a picture of a screen: tables wrapped to the
  // pane width, long answers cut. Say which one this is rather than letting a
  // mangled table look like the agent's doing.
  const body = !text
    ? `${head}这一轮结束了，但它一个字都没发到群里，原文也没读到。得回电脑看。`
    : source === 'transcript'
      ? `${head}这一轮结束了，但它一个字都没发到群里。下面是**它这一轮说的原话**：\n\n${text}`
      : `${head}这一轮结束了，但它一个字都没发到群里。下面是**终端里的原文**（直接抄的终端输出，表格可能被折行）：\n\n\`\`\`\n${text}\n\`\`\``;
  return card({ icon: '🔇', title: `[${projectLabel}] 它没把回复同步过来`, template: 'orange' }, [
    md(body),
    { tag: 'markdown', content: "<font color='grey'>要接着说就直接在这儿回</font>", text_size: 'notation' },
  ]);
}

/** Sent into the group when a phone message could not reach the terminal. */
export function receiptCard(projectLabel: string, why: string, lang: Lang = 'zh'): object {
  const T = t(lang);
  return card({ icon: '⚠️', title: `[${projectLabel}] ${T.notDelivered}`, template: 'orange' }, [
    md(T.notDeliveredBody(why)),
  ]);
}

/**
 * The WebSocket carries messages *in*; sending goes out over REST. So when
 * the subscription drops, the channel half-works: replies still reach the
 * phone while everything the human sends vanishes, with nothing anywhere
 * saying so. This card uses the half that still works to report the half
 * that does not.
 */
export function linkCard(projectLabel: string, state: 'down' | 'back', detail: string, lang: Lang = 'zh'): object {
  const T = t(lang);
  return card(
    {
      icon: state === 'down' ? '📵' : '📶',
      title: `[${projectLabel}] ${state === 'down' ? T.linkDown : T.linkBack}`,
      template: state === 'down' ? 'red' : 'green',
    },
    [md(detail)],
  );
}

export function statusCard(
  projectLabel: string,
  status: 'blocked' | 'idle',
  detail: string,
  lang: Lang = 'zh',
): object {
  const T = t(lang);
  return card(
    {
      icon: status === 'blocked' ? '🔔' : '🏁',
      title: `[${projectLabel}] ${status === 'blocked' ? T.statusBlocked : T.statusIdle}`,
      template: status === 'blocked' ? 'orange' : 'green',
    },
    [md(detail)],
  );
}
