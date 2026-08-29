// Adding someone you just met. A name is all we ask for — everything else can
// wait until you have spoken to them, and a form that demands more up front is
// a form that stops getting used.

import { useState } from 'react';
import { Modal } from '../../../components/Modal';
import { api } from '../../../lib/api';
import { showErrorDialog } from '../../../lib/errorToast';
import { useT } from '../../../lib/i18n';

export function AddClientModal({ onClose, onCreated }: {
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) { showErrorDialog(t('cliNeedName')); return; }
    setSaving(true);
    try {
      const r = await api.post<{ id: string }>('/api/suppliers', {
        name: name.trim(),
        phone: phone.trim() || null,
        city: city.trim() || null,
        status: 'prospect',
      });
      onCreated(r.id);
    } catch (e) {
      showErrorDialog(e instanceof Error ? e.message : t('cliAddFailed'));
    } finally { setSaving(false); }
  };

  return (
    <Modal onClose={onClose} ariaLabel={t('cliAddTitle')} shellClassName="cli-modal">
      <form className="cli-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <h2 className="cli-modal-title">{t('cliAddTitle')}</h2>
        <label className="cli-field">
          <span>{t('cliFieldName')}</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder={t('cliFieldNamePh')} autoFocus />
        </label>
        <div className="cli-field-row">
          <label className="cli-field">
            <span>{t('cliFieldPhone')}</span>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)}
              inputMode="tel" />
          </label>
          <label className="cli-field">
            <span>{t('cliFieldCity')}</span>
            <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
        </div>
        <p className="cli-form-hint">{t('cliAddHint')}</p>
        <div className="cli-form-foot">
          <button type="button" className="btn" onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('cliSaving') : t('cliAddSubmit')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
