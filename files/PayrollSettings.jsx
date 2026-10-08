import { useState, useEffect, useCallback } from 'react';
import api from '../../api/axios';
import {
  RefreshCw, AlertCircle, CheckCircle2, X, Settings, Pencil, Banknote, Smartphone, Store, User,
} from 'lucide-react';

const formatDZD = (n) =>
  new Intl.NumberFormat('fr-DZ', {
    style: 'currency', currency: 'DZD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** All payroll settings in one place: app-installation commission, base salaries, per-cashier app commission. */
export default function PayrollSettings() {
  const [cashiers, setCashiers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [commission, setCommission] = useState('');
  const [commissionSaving, setCommissionSaving] = useState(false);

  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState({ base_salary: '', effective_from: '' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const [togglingId, setTogglingId] = useState(null);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 4000); };

  const fetchCashiers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/advances/salary');
      setCashiers(r.data.data?.items || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load cashiers.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCashiers(); }, [fetchCashiers]);

  useEffect(() => {
    api.get('/advances/settings')
      .then((r) => setCommission(String(r.data.data?.app_install_commission ?? 0)))
      .catch(() => {});
  }, []);

  const saveCommission = async () => {
    const raw = String(commission).trim();
    if (!AMOUNT_RE.test(raw)) { setError('Enter a valid amount (up to 2 decimals).'); return; }
    setCommissionSaving(true);
    setError('');
    try {
      await api.put('/advances/settings', { app_install_commission: Number(raw) });
      flash(`Saved. Each new My Ooredoo app installation is now worth ${formatDZD(Number(raw))}.`);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save settings.');
    } finally {
      setCommissionSaving(false);
    }
  };

  const openEdit = (r) => {
    setEditTarget(r);
    setEditForm({ base_salary: r.base_salary ? String(r.base_salary) : '', effective_from: todayStr() });
    setEditError('');
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    const raw = String(editForm.base_salary).trim();
    if (!AMOUNT_RE.test(raw)) { setEditError('Enter a valid amount (up to 2 decimals).'); return; }
    setEditSaving(true);
    setEditError('');
    try {
      await api.put('/advances/salary/base', {
        cashier_id: editTarget.cashier_id,
        base_salary: Number(raw),
        effective_from: editForm.effective_from || undefined,
      });
      flash(`Base salary of ${editTarget.cashier_name} set to ${formatDZD(Number(raw))}.`);
      setEditTarget(null);
      fetchCashiers();
    } catch (err) {
      setEditError(err.response?.data?.message || 'Failed to save base salary.');
    } finally {
      setEditSaving(false);
    }
  };

  const toggleApp = async (r, enabled) => {
    setTogglingId(r.cashier_id);
    setError('');
    try {
      await api.patch('/advances/salary/app-commission', { cashier_id: r.cashier_id, enabled });
      await fetchCashiers();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to update.');
    } finally {
      setTogglingId(null);
    }
  };

  const th = 'px-3 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider';

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" /><span>{error}</span>
        </div>
      )}
      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700 flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" /><span>{success}</span>
        </div>
      )}

      {/* Global commission */}
      <div className="rounded-xl bg-white shadow-sm ring-1 ring-gray-200 p-5">
        <h3 className="font-bold text-gray-900 flex items-center gap-2 mb-3">
          <Settings size={18} className="text-red-600" /> Commission settings
        </h3>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          <Smartphone size={14} className="inline mr-1" />
          Commission per My Ooredoo app installation (DZD)
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="number" min="0" step="0.01" value={commission}
            onChange={(e) => setCommission(e.target.value)}
            className="w-40 rounded-md border border-gray-300 px-3 py-2 text-sm font-bold focus:border-red-500 focus:ring-red-500"
            placeholder="0.00"
          />
          <button
            onClick={saveCommission} disabled={commissionSaving}
            className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            <CheckCircle2 size={16} /> {commissionSaving ? 'Saving...' : 'Save'}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Applies to installations recorded from now on. Past installations keep the amount they had when the SIM was sold.
        </p>
      </div>

      {/* Per-cashier settings */}
      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className={`${th} text-left`}>Cashier</th>
              <th className={`${th} text-right`}>Base salary</th>
              <th className={`${th} text-left`}>My Ooredoo app commission</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {loading ? (
              <tr><td colSpan="3" className="px-4 py-8 text-center"><RefreshCw className="inline animate-spin text-red-600" /></td></tr>
            ) : cashiers.length === 0 ? (
              <tr><td colSpan="3" className="px-4 py-8 text-center text-gray-500">No active cashiers found.</td></tr>
            ) : (
              cashiers.map((r) => (
                <tr key={r.cashier_id} className="hover:bg-gray-50">
                  <td className="px-3 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center">
                        <User size={16} className="text-gray-500" />
                      </div>
                      <div>
                        <div className="font-medium text-gray-900">{r.cashier_name}</div>
                        <div className="text-xs text-gray-500 flex items-center gap-1"><Store size={11} /> {r.store_name || '—'}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <span className="font-semibold text-gray-900">{formatDZD(r.base_salary)}</span>
                    <button
                      onClick={() => openEdit(r)}
                      className="ml-2 inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-200"
                      title="Set or change the base salary"
                    >
                      <Pencil size={12} /> Edit
                    </button>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={r.app_commission_enabled}
                        disabled={togglingId === r.cashier_id}
                        onChange={(e) => toggleApp(r, e.target.checked)}
                        className="h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
                      />
                      <span className="text-xs font-semibold text-gray-700">Add app commission to the salary</span>
                    </label>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Base salary modal */}
      {editTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 p-4">
              <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
                <Banknote className="text-red-600" size={20} /> Base salary
              </h3>
              <button onClick={() => !editSaving && setEditTarget(null)} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            <form onSubmit={submitEdit} className="p-6 space-y-4">
              <div className="rounded-md bg-gray-50 p-3 border border-gray-200">
                <div className="text-xs uppercase tracking-wider text-gray-500">Cashier</div>
                <div className="font-semibold text-gray-900">{editTarget.cashier_name}</div>
                <div className="text-xs text-gray-500 mt-1">Current: {formatDZD(editTarget.base_salary)}</div>
              </div>
              {editError && (
                <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{editError}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">New base salary (DZD) <span className="text-red-600">*</span></label>
                <input
                  type="number" required min="0" step="0.01" autoFocus value={editForm.base_salary}
                  onChange={(e) => setEditForm((f) => ({ ...f, base_salary: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Effective from</label>
                <input
                  type="date" value={editForm.effective_from}
                  onChange={(e) => setEditForm((f) => ({ ...f, effective_from: e.target.value }))}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
                />
                <p className="mt-1 text-xs text-gray-500">
                  A month uses the base salary in effect at its end (today, for the current month). Past months are not changed
                  unless you pick an earlier date.
                </p>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={() => setEditTarget(null)} disabled={editSaving}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={editSaving}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50">
                  <CheckCircle2 size={16} /> {editSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
