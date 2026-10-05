import { describe, it, expect } from 'vitest';
import { mailDate, mailSnippet, splitQuotedReply } from './mailQuote';

describe('splitQuotedReply', () => {
  it('folds Gmail history, including a wrapped "wrote:" line', () => {
    expect(splitQuotedReply('Yes, $40 works.\n\nOn Mon, Oct 3, 2026 at 5:01 PM ram4cash <sales@x.com> wrote:\n> Offer'))
      .toEqual({ reply: 'Yes, $40 works.', quoted: 'On Mon, Oct 3, 2026 at 5:01 PM ram4cash <sales@x.com> wrote:\n> Offer' });
    expect(splitQuotedReply('Deal\n\nOn Mon, Oct 3, 2026 at 5:01 PM ram4cash <\nsales@x.com> wrote:\n> Offer').reply)
      .toBe('Deal');
  });

  it('folds an Outlook / Lark header block but not a lone "From:" line', () => {
    const outlook = 'Shipping Monday.\n\nFrom: ram4cash <sales@x.com>\nSent: Monday\nTo: me\nSubject: Your sell request';
    expect(splitQuotedReply(outlook).reply).toBe('Shipping Monday.');
    const lark = '好的\n\n发件人: ram4cash <sales@x.com>\n发送时间: 2026年10月3日\n收件人: me';
    expect(splitQuotedReply(lark).reply).toBe('好的');
    const prose = 'Two lots.\nFrom: my office in Denver\nand the warehouse.';
    expect(splitQuotedReply(prose)).toEqual({ reply: prose, quoted: '' });
  });

  it('folds "Original Message" and a trailing > run', () => {
    expect(splitQuotedReply('ok\n-----Original Message-----\nold').reply).toBe('ok');
    expect(splitQuotedReply('Sounds good\n\n> Offer\n> line 2\n')).toEqual({ reply: 'Sounds good', quoted: '> Offer\n> line 2' });
  });

  it('never folds the whole body away', () => {
    expect(splitQuotedReply('On Monday I can ship.\nThanks')).toEqual({ reply: 'On Monday I can ship.\nThanks', quoted: '' });
    expect(splitQuotedReply('> only quoted').reply).toBe('> only quoted');
    expect(splitQuotedReply('')).toEqual({ reply: '', quoted: '' });
  });
});

describe('mailSnippet', () => {
  it('is what the sender wrote, on one line', () => {
    expect(mailSnippet('Hi Alex,\n\nSure, photo attached.\n\nOn Mon, Oct 3 ram4cash <s@x.com> wrote:\n> Offer'))
      .toBe('Hi Alex, Sure, photo attached.');
    expect(mailSnippet('   ')).toBe('');
  });
});

describe('mailDate', () => {
  const now = new Date(2026, 9, 4, 15, 0);
  it('shows the time today, the day this year, and the year before that', () => {
    expect(mailDate(new Date(2026, 9, 4, 9, 12), now, 'en-US')).toBe('9:12 AM');
    expect(mailDate(new Date(2026, 9, 3, 23, 59), now, 'en-US')).toBe('Oct 3');
    expect(mailDate(new Date(2025, 11, 30), now, 'en-US')).toBe('Dec 30, 2025');
  });
});
