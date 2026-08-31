// Everything about a client a person maintains. The preferences are pickers
// rather than free text because they are asked on every deal, and because a
// typed value cannot later be filtered on.

import { useState } from 'react';
import { Modal } from '../../../components/Modal';
import { api } from '../../../lib/api';
import { showErrorDialog } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';
import type { ClientDetail } from '../../../lib/clients';

const PAY = ['PayPal', 'Zelle', 'Check', 'Cash', 'Wire'];
const SHIP = ['cliShipThey', 'cliShipLabel', 'cliShipPickup', 'cliShipDrop'];
const REACH = ['cliReachCall', 'cliReachText', 'cliReachEmail', 'cliReachWhatsApp', 'cliReachWeChat'];

export function EditClient({ client, onClose, onSaved }: {
  client: ClientDetail; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useT();
  const [f, setF] = useState({
    name: client.name,
    phone: client.phone ?? '',
    email: client.email ?? '',
    city: client.address.city ?? '',
    supplies: client.supplies.join(', '),
    payment: client.preferences.payment ?? '',
    logistics: client.preferences.logistics ?? '',
    contact: client.preferences.contact ?? '',
    bestTime: client.preferences.bestTime ?? '',
    price: client.preferences.price ?? '',
    notes: client.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/suppliers/${client.id}`, {
        name: f.name.trim(),
        phone: f.phone.trim() || null,
        email: f.email.trim() || null,
        city: f.city.trim() || null,
        supplies: f.supplies.split(',').map((s) => s.trim()).filter(Boolean),
        prefPayment: f.payment || null,
        prefLogistics: f.logistics || null,
        prefContact: f.contact || null,
        prefBestTime: f.bestTime.trim() || null,
        prefPrice: f.price.trim() || null,
        notes: f.notes.trim() || null,
      });
      onSaved();
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('cliSaveFailed'));
    } finally { setSaving(false); }
  };

  const Picker = ({ label, options, value, onPick, translate }: {
    label: string; options: string[]; value: string;
    onPick: (v: string) => void; translate?: boolean;
  }) => (
    <div className="cli-field">
      <span>{label}</span>
      <div className="cli-pick">
        {options.map((o) => {
          const text = translate ? t(o) : o;
          const on = value === text;
          return (
            <button key={o} type="button" className={`cli-pick-btn${on ? ' on' : ''}`}
              aria-pressed={on} onClick={() => onPick(on ? '' : text)}>{text}</button>
          );
        })}
      </div>
    </div>
  );

  return (
    <Modal onClose={onClose} ariaLabel={t('cliEditTitle')} shellClassName="cli-modal cli-modal-wide">
      <form className="cli-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2 className="cli-modal-title">{t('cliEditTitle')}</h2>

        <div className="cli-field-row">
          <label className="cli-field"><span>{t('cliFieldName')}</span>
            <input className="input" value={f.name} onChange={(e) => set('name')(e.target.value)} /></label>
          <label className="cli-field"><span>{t('cliFieldPhone')}</span>
            <input className="input" value={f.phone} onChange={(e) => set('phone')(e.target.value)} inputMode="tel" /></label>
        </div>
        <div className="cli-field-row">
          <label className="cli-field"><span>{t('cliFieldEmail')}</span>
            <input className="input" value={f.email} onChange={(e) => set('email')(e.target.value)} inputMode="email" /></label>
          <label className="cli-field"><span>{t('cliFieldCity')}</span>
            <input className="input" value={f.city} onChange={(e) => set('city')(e.target.value)} /></label>
        </div>

        <label className="cli-field">
          <span>{t('cliFieldSupplies')}</span>
          <input className="input" value={f.supplies} onChange={(e) => set('supplies')(e.target.value)}
            placeholder={t('cliFieldSuppliesPh')} />
          <small className="cli-form-hint">{t('cliFieldSuppliesHint')}</small>
        </label>

        <Picker label={t('cliPrefPay')} options={PAY} value={f.payment} onPick={set('payment')} />
        <Picker label={t('cliPrefShip')} options={SHIP} value={f.logistics} onPick={set('logistics')} translate />
        <Picker label={t('cliPrefReach')} options={REACH} value={f.contact} onPick={set('contact')} translate />

        <div className="cli-field-row">
          <label className="cli-field"><span>{t('cliPrefTime')}</span>
            <input className="input" value={f.bestTime} onChange={(e) => set('bestTime')(e.target.value)}
              placeholder={t('cliPrefTimePh')} /></label>
          <label className="cli-field"><span>{t('cliPrefPrice')}</span>
            <input className="input" value={f.price} onChange={(e) => set('price')(e.target.value)}
              placeholder={t('cliPrefPricePh')} /></label>
        </div>

        <label className="cli-field"><span>{t('cliFieldNotes')}</span>
          <textarea className="input" rows={3} value={f.notes}
            onChange={(e) => set('notes')(e.target.value)} /></label>

        <div className="cli-form-foot">
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('cliSaving') : t('cliSave')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
