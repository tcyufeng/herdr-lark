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
    asking: '等你拍板',
    confirmTitle: '确认执行',
    confirmText: (label: string) => `“${label}”是不可逆或高代价的操作。确定选它？`,
    notDelivered: '没能送达',
    notDeliveredBody: (why: string) => `刚才那条消息没能送进终端：${why}`,
    statusBlocked: '等你输入',
    statusIdle: '干完了',
    statusTitle: (label: string) => `[${label}] agent ${'状态变化'}`,
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
    asking: 'Needs your call',
    confirmTitle: 'Confirm',
    confirmText: (label: string) => `"${label}" is irreversible or high-cost. Go ahead?`,
    notDelivered: 'Not delivered',
    notDeliveredBody: (why: string) => `That message never reached the terminal: ${why}`,
    statusBlocked: 'waiting for you',
    statusIdle: 'finished',
    statusTitle: (label: string) => `[${label}] agent state`,
  },
} as const;

export const t = (lang: Lang = 'zh') => TEXTS[lang];

/** lark_md has no list syntax; numbers are drawn as characters instead. */
const MARKERS = ['①', '②', '③', '④', '⑤'] as const;

const md = (content: string): object => ({ tag: 'div', text: { tag: 'lark_md', content } });
const hr = (): object => ({ tag: 'hr' });
const note = (content: string): object => ({
  tag: 'note',
  elements: [{ tag: 'plain_text', content }],
});

function field(label: string, value: string): string {
  return `**${label}**　${value}`;
}

function optionLines(options: AskOption[], recommend: string, lang: Lang): string {
  const T = t(lang);
  return options
    .map((o, i) => {
      const marker = MARKERS[i] ?? `${i + 1}.`;
      const flag = o.id === recommend ? `　${T.recommended}` : o.danger ? '　⚠️' : '';
      return `${marker} **${o.label}**${flag}\n${o.consequence}`;
    })
    .join('\n\n');
}

export interface AskCardContext {
  payload: AskPayload;
  projectLabel: string;
  reqId: string;
  state: AskState;
  /** Present once the human has answered. */
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
  const title = `${head.icon} [${ctx.projectLabel}] ${p.title}${statusWord ? ` · ${statusWord}` : ''}`;

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

  if (state === 'pending') {
    const hasDanger = p.options.some((o) => o.danger);
    elements.push({
      tag: 'action',
      actions: p.options.map((o) => {
        const button: Record<string, unknown> = {
          tag: 'button',
          text: { tag: 'plain_text', content: o.label },
          type: o.danger ? 'danger' : o.id === p.recommend ? 'primary' : 'default',
          value: { reqId: ctx.reqId, optionId: o.id },
        };
        if (o.danger) {
          button.confirm = {
            title: { tag: 'plain_text', content: T.confirmTitle },
            text: { tag: 'plain_text', content: T.confirmText(o.label) },
          };
        }
        return button;
      }),
    });
    elements.push(note(hasDanger ? T.hintDanger : T.hint));
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template: head.template },
    elements,
  };
}

export function notifyCard(p: NotifyPayload, projectLabel: string): object {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `📣 [${projectLabel}] ${p.title}` },
      template: 'wathet',
    },
    elements: [md(p.body)],
  };
}

/**
 * Sent into the group when a message from the phone could not be injected —
 * the human must see that their instruction went nowhere.
 */
export function receiptCard(projectLabel: string, why: string, lang: Lang = 'zh'): object {
  const T = t(lang);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `⚠️ [${projectLabel}] ${T.notDelivered}` },
      template: 'orange',
    },
    elements: [md(T.notDeliveredBody(why))],
  };
}

export function statusCard(
  projectLabel: string,
  status: 'blocked' | 'idle',
  detail: string,
  lang: Lang = 'zh',
): object {
  const T = t(lang);
  const word = status === 'blocked' ? T.statusBlocked : T.statusIdle;
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${status === 'blocked' ? '🔔' : '🏁'} [${projectLabel}] ${word}` },
      template: status === 'blocked' ? 'orange' : 'green',
    },
    elements: [md(detail)],
  };
}
