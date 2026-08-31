// The client card, read mid-call. Ordered the way the conversation goes: who
// they are, how to reach them, why they're on today's list, what they sold us,
// what they want next time, then what was said last time.

import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../../../components/Icon';
import { Modal } from '../../../components/Modal';
import { RhythmStrip } from '../../../components/RhythmStrip';
import { api } from '../../../lib/api';
import { handleFetchError } from '../../../lib/errorToast';
import { fmtUSD0 } from '../../../lib/format';
import { useT } from '../../../lib/i18n';
import {
  type ClientDetail, TIER_KEY, HEALTH_KEY, HEALTH_TONE, KIND_KEY, dueLabel, dueTone, isAutoBody,
} from '../../../lib/clients';
import { LogContact } from './LogContact';
import { EditClient } from './EditClient';

export function ClientDrawer({ id, onClose, onChanged, showToast }: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
  showToast: (m: string, k?: 'success' | 'error' | 'warn') => void;
}) {
  const { t, lang } = useT();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [c, setC] = useState<ClientDetail | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api.get<ClientDetail>(`/api/suppliers/${id}`).then(setC).catch(handleFetchError);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (!c) {
    return (
      <Modal onClose={onClose} ariaLabel={t('cliDrawerAria')} shellClassName="cli-drawer">
        <div className="cli-drawer-body"><p className="cli-muted">{t('loadingApp')}</p></div>
      </Modal>
    );
  }

  const where = [c.address.city, c.address.state].filter(Boolean).join(', ');
  const soldMax = c.sold.length ? Math.max(...c.sold.map((s) => s.qty)) : 1;

  return (
    <Modal onClose={onClose} ariaLabel={c.name} shellClassName="cli-drawer">
      <div className="cli-drawer-head">
        <div className="cli-drawer-top">
          <div>
            <div className="cli-drawer-name">{c.name}</div>
            <div className="cli-drawer-where">
              {where}
              {c.ownerName ? ` · ${t('cliOwnedBy', { name: c.ownerName })}` : ` · ${t('cliHouse')}`}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="cli-drawer-chips">
          <span className={`chip chip-${HEALTH_TONE[c.health]}`}>{t(HEALTH_KEY[c.health])}</span>
          <span className={`chip chip-${dueTone(c.dueState)}`}>{dueLabel(c, t)}</span>
          <span className="chip chip-muted">
            {t(TIER_KEY[c.tier])} · {t('cliEveryNDays', { n: c.cadenceDays })}
          </span>
        </div>
        <div className="cli-quick">
          {c.phone && <a className="btn btn-primary cli-quick-btn" href={`tel:${c.phone}`}>{t('cliCall')}</a>}
          {c.phone && <a className="btn cli-quick-btn" href={`sms:${c.phone}`}>{t('cliText')}</a>}
          {c.email && <a className="btn cli-quick-btn" href={`mailto:${c.email}`}>{t('cliEmail')}</a>}
        </div>
      </div>

      <div className="cli-drawer-body">
        {(c.health === 'quiet' || c.health === 'lost') && c.typicalGapDays && (
          <div className="cli-quiet-note">
            <Icon name="alert" size={14} />
            <span>{t('cliQuietExplain', { gap: c.typicalGapDays, days: c.daysSinceLastPo ?? 0 })}</span>
          </div>
        )}

        {c.poCount > 0 && (
          <section className="cli-sec">
            <RhythmStrip poDaysAgo={c.rhythm} gapDays={c.typicalGapDays}
              health={c.health} size="detail" />
            <div className="rhythm-cap">
              <span>{t('cliTwelveMonths')}</span>
              <span>{t('cliEachMark')}</span>
              <span>{t('cliToday')}</span>
            </div>
          </section>
        )}

        <section className="cli-sec">
          <h3 className="cli-sec-h">{t('cliContactH')}</h3>
          <dl className="cli-kv">
            {c.phone && <><dt>{t('cliPhone')}</dt><dd>{c.phone}</dd></>}
            {c.email && <><dt>{t('cliEmailLabel')}</dt><dd>{c.email}</dd></>}
            {(c.address.street1 || where) && (
              <><dt>{t('cliAddress')}</dt>
                <dd>{[c.address.street1, c.address.street2, where, c.address.zip]
                  .filter(Boolean).join(', ')}</dd></>
            )}
          </dl>
        </section>

        {c.sold.length > 0 && (
          <section className="cli-sec">
            <h3 className="cli-sec-h">
              {t('cliSoldH')} <span className="cli-derived">{t('cliDerived')}</span>
            </h3>
            <div className="cli-sold">
              {c.sold.map((s) => (
                <div className="cli-sold-row" key={s.item_type}>
                  <span className="cli-sold-name">{s.item_type}</span>
                  <span className="cli-sold-bar">
                    <i style={{ width: `${Math.round((s.qty / soldMax) * 100)}%` }} />
                  </span>
                  <span className="cli-sold-qty">{t('cliUnits', { n: s.qty })}</span>
                </div>
              ))}
            </div>
            <p className="cli-sold-foot">
              {t('cliSoldFoot', { n: c.poCount, total: fmtUSD0(c.spendRecent) })}
            </p>
          </section>
        )}

        <section className="cli-sec">
          <div className="cli-sec-head-row">
            <h3 className="cli-sec-h">{t('cliSaysH')}</h3>
            {c.canEdit && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(true)}>
                {t('cliEdit')}
              </button>
            )}
          </div>
          {c.supplies.length > 0
            ? <div className="cli-tags">{c.supplies.map((s) => <span className="cli-tag" key={s}>{s}</span>)}</div>
            : <p className="cli-muted">{t('cliSaysEmpty')}</p>}
          {c.notes && <p className="cli-notes-text">{c.notes}</p>}
        </section>

        <section className="cli-sec">
          <h3 className="cli-sec-h">{t('cliPrefsH')}</h3>
          <dl className="cli-kv">
            <dt>{t('cliPrefPay')}</dt><dd>{c.preferences.payment || '—'}</dd>
            <dt>{t('cliPrefShip')}</dt><dd>{c.preferences.logistics || '—'}</dd>
            <dt>{t('cliPrefReach')}</dt><dd>{c.preferences.contact || '—'}</dd>
            <dt>{t('cliPrefTime')}</dt><dd>{c.preferences.bestTime || '—'}</dd>
            <dt>{t('cliPrefPrice')}</dt><dd>{c.preferences.price || '—'}</dd>
          </dl>
        </section>

        {c.canEdit && (
          <section className="cli-sec">
            <h3 className="cli-sec-h">{t('cliLogH')}</h3>
            <LogContact
              id={c.id}
              cadenceDays={c.cadenceDays}
              onSaved={(next) => {
                load();
                onChanged();
                showToast(t('cliLoggedToast', {
                  when: new Date(`${next}T12:00:00`).toLocaleDateString(locale,
                    { month: 'short', day: 'numeric' }),
                }));
              }}
            />
          </section>
        )}

        <section className="cli-sec">
          <h3 className="cli-sec-h">{t('cliHistoryH')}</h3>
          {c.timeline.length === 0
            ? <p className="cli-muted">{t('cliHistoryEmpty')}</p>
            : (
              <div className="cli-timeline">
                {c.timeline.map((n) => (
                  <div className={`cli-tl-item cli-tl-${n.kind}`} key={n.id}>
                    {!isAutoBody(n.body) && <div className="cli-tl-body">{n.body}</div>}
                    <div className="cli-tl-meta">
                      {n.kind !== 'owner_changed' &&
                        `${t(KIND_KEY[n.kind as keyof typeof KIND_KEY] ?? 'cliKindNote')} · `}
                      {new Date(n.created_at).toLocaleDateString(locale,
                        { month: 'short', day: 'numeric' })}
                      {n.author ? ` · ${n.author}` : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>

        {c.orders.length > 0 && (
          <section className="cli-sec">
            <h3 className="cli-sec-h">{t('cliOrdersH', { n: c.orders.length })}</h3>
            <div className="cli-orders">
              {c.orders.slice(0, 8).map((o) => (
                <a className="cli-order" key={o.id} href={`#/purchase-orders/${o.id}`}>
                  <span className="cli-order-id">{o.id}</span>
                  <span className="cli-order-date">
                    {new Date(o.created_at).toLocaleDateString(locale,
                      { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                  <span className="cli-order-total">{o.total_cost ? fmtUSD0(o.total_cost) : '—'}</span>
                </a>
              ))}
            </div>
          </section>
        )}
      </div>

      {editing && (
        <EditClient
          client={c}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); load(); onChanged(); }}
        />
      )}
    </Modal>
  );
}
