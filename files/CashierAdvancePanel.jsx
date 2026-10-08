import { useState, useEffect } from 'react';
import api from '../api/axios';
import { useLanguage } from '../context/LanguageContext';
import {
  X, RefreshCw, Plus, Wallet, Ban, CheckCircle2,
  ArrowDownCircle, ArrowUpCircle, ChevronLeft, ChevronRight, AlertTriangle
} from 'lucide-react';

const PAGE_SIZE = 50;
const AMOUNT_MIN = 0.01;
const AMOUNT_MAX = 9999999999.99;
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const NOTE_MAX = 500;

const formatDZD = (n) =>
  new Intl.NumberFormat('fr-DZ', { style: 'currency', currency: 'DZD' }).format(Number(n) || 0);

const formatTimestamp = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString([], {
      year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

export default function CashierAdvancePanel({ sessionId = null, refreshKey = 0, onChange }) {
  const { t } = useLanguage();
  const [data, setData] = useState({ outstanding_balance: 0, items: [] });
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [internalRefresh, setInternalRefresh] = useState(0);
  const [payroll, setPayroll] = useState(null);

  const [showModal, setShowModal] = useState(false);
  const [formAmount, setFormAmount] = useState('');
  const [formNote, setFormNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

  const [rowToVoid, setRowToVoid] = useState(null);
  const [voidReason, setVoidReason] = useState('');
  const [voidSubmitting, setVoidSubmitting] = useState(false);
  const [voidError, setVoidError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError('');
      try {
        const offset = page * PAGE_SIZE;
        const res = await api.get('/advances/me', { params: { limit: PAGE_SIZE, offset } });
        if (cancelled) return;
        const payload = res.data?.data || { outstanding_balance: 0, items: [] };
        setData({
          outstanding_balance: Number(payload.outstanding_balance) || 0,
          items: Array.isArray(payload.items) ? payload.items : [],
        });
        setHasMore((payload.items?.length || 0) === PAGE_SIZE);
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || t('common.action_failed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [page, refreshKey, internalRefresh]);

  useEffect(() => {
    let cancelled = false;
    api.get('/advances/salary/me')
      .then((res) => { if (!cancelled) setPayroll(res.data?.data || null); })
      .catch(() => { if (!cancelled) setPayroll(null); });
    return () => { cancelled = true; };
  }, [refreshKey, internalRefresh]);

  const refreshPanel = () => setInternalRefresh((n) => n + 1);

  const openModal = () => {
    setFormAmount(''); setFormNote(''); setFormError(''); setShowModal(true);
  };

  const closeModal = () => {
    if (submitting) return;
    setShowModal(false);
  };

  const handleSubmitAdvance = async (e) => {
    e.preventDefault();
    setFormError('');

    const raw = String(formAmount).trim();
    if (!raw || !AMOUNT_RE.test(raw)) {
      setFormError('Amount must be a positive number with up to 2 decimal places.');
      return;
    }
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < AMOUNT_MIN || amount > AMOUNT_MAX) {
      setFormError(`Amount must be between ${formatDZD(AMOUNT_MIN)} and ${formatDZD(AMOUNT_MAX)}.`);
      return;
    }
    const noteTrim = formNote.trim();
    if (noteTrim.length > NOTE_MAX) {
      setFormError(`Note must be at most ${NOTE_MAX} characters.`);
      return;
    }

    try {
      setSubmitting(true);
      await api.post('/advances', { amount, ...(noteTrim ? { note: noteTrim } : {}) });
      setShowModal(false);
      if (page !== 0) setPage(0); else refreshPanel();
      onChange?.();
    } catch (err) {
      setFormError(err.response?.data?.message || t('common.action_failed'));
    } finally {
      setSubmitting(false);
    }
  };

  const canVoidRow = (row) => !row.is_voided && row.direction === 'advance' && sessionId != null && row.session_id === sessionId;

  const openVoidModal = (row) => {
    setRowToVoid(row); setVoidReason(''); setVoidError('');
  };

  const closeVoidModal = () => {
    if (voidSubmitting) return;
    setRowToVoid(null);
  };

  const submitVoid = async (e) => {
    e.preventDefault();
    setVoidError('');
    const trimmed = voidReason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) {
      setVoidError('Reason must be between 1 and 500 characters.');
      return;
    }

    try {
      setVoidSubmitting(true);
      await api.post(`/advances/${rowToVoid.id}/void`, { reason: trimmed });
      setRowToVoid(null);
      refreshPanel();
      onChange?.();
    } catch (err) {
      setVoidError(err.response?.data?.message || t('common.action_failed'));
    } finally {
      setVoidSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm ring-1 ring-gray-200 overflow-hidden text-start">
      <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 flex justify-between items-center">
        <h3 className="font-semibold text-gray-900 flex items-center gap-2">
          <Wallet size={18} className="text-purple-600" /> {t('advances.title')}
        </h3>
        <button onClick={refreshPanel} className="text-gray-500 hover:text-purple-600">
          <RefreshCw size={16} />
        </button>
      </div>

      {payroll && (
        <div className="px-4 py-4 border-b border-gray-100 bg-gradient-to-br from-emerald-50 to-white">
          <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">My salary · {payroll.month}</p>
          <p className="text-3xl font-extrabold text-gray-900">{formatDZD(payroll.total_salary)}</p>
          <div className="mt-3 space-y-1 text-sm text-gray-600">
            <div className="flex justify-between"><span>Base salary</span><span className="font-medium text-gray-900">{formatDZD(payroll.base_salary)}</span></div>
            <div className="flex justify-between"><span>SIM commission ({payroll.sim_units})</span><span className="font-medium text-gray-900">{formatDZD(payroll.sim_commission)}</span></div>
            <div className="flex justify-between"><span>Accessory commission ({payroll.accessory_units})</span><span className="font-medium text-gray-900">{formatDZD(payroll.accessory_commission)}</span></div>
            {payroll.app_commission_enabled && (
              <div className="flex justify-between"><span>My Ooredoo app ({payroll.app_installs})</span><span className="font-medium text-gray-900">{formatDZD(payroll.app_commission)}</span></div>
            )}
          </div>

          {/* What the admin already paid out of the register this month */}
          <div className="mt-3 pt-3 border-t border-gray-200 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">Paid to me</span><span className="font-bold text-green-700">{formatDZD(payroll.amount_paid)}</span></div>
            {Number(payroll.advance_deducted) > 0 && (
              <div className="flex justify-between"><span className="text-gray-600">Advance deducted</span><span className="font-medium text-orange-700">{formatDZD(payroll.advance_deducted)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-gray-600">Still to receive</span><span className="font-bold text-gray-900">{formatDZD(payroll.remaining_salary)}</span></div>
          </div>

          {Array.isArray(payroll.payments) && payroll.payments.length > 0 && (
            <div className="mt-3 space-y-1">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Payments received</p>
              {payroll.payments.map((p) => (
                <div key={p.id} className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${p.is_voided ? 'bg-red-50/50 border-red-100 opacity-75' : 'bg-white border-gray-100'}`}>
                  <div className="min-w-0">
                    <p className={`font-medium ${p.is_voided ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                      {formatDZD(p.amount)}
                      {Number(p.advance_deducted) > 0 && <span className="text-xs text-gray-500 font-normal"> + {formatDZD(p.advance_deducted)} advance deducted</span>}
                    </p>
                    <p className="text-xs text-gray-400">
                      {formatTimestamp(p.created_at)}
                      {p.note && <span> — {p.note}</span>}
                      {p.is_voided && <span className="mx-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 uppercase tracking-wider">{t('advances.voided')}</span>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-5 border-b border-gray-100 bg-gradient-to-br from-purple-50 to-white">
        <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">
          {t('advances.outstanding')}
        </p>
        <p className="text-3xl font-extrabold text-gray-900">
          {formatDZD(data.outstanding_balance)}
        </p>
        <button
          onClick={openModal}
          disabled={sessionId == null}
          className="mt-3 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-purple-600 rounded-md hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus size={16} /> {t('advances.record_btn')}
        </button>
      </div>

      {error && <div className="px-4 py-2 bg-red-50 border-b border-red-100 text-sm text-red-700">{error}</div>}

      <div className="p-2 max-h-80 overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-6"><RefreshCw className="animate-spin text-gray-400" /></div>
        ) : data.items.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">{t('advances.no_history')}</p>
        ) : (
          <div className="space-y-2">
            {data.items.map((row) => {
              const isAdvance = row.direction === 'advance';
              return (
                <div key={row.id} className={`flex items-center justify-between p-3 rounded-lg border ${row.is_voided ? 'bg-red-50/50 border-red-100 opacity-75' : 'bg-white border-gray-100 hover:bg-gray-50'}`}>
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`p-2 rounded-full ${row.is_voided ? 'bg-red-100' : isAdvance ? 'bg-purple-100' : 'bg-green-100'}`}>
                      {row.is_voided ? <Ban size={16} className="text-red-500" /> : isAdvance ? <ArrowDownCircle size={16} className="text-purple-600" /> : <ArrowUpCircle size={16} className="text-green-600" />}
                    </div>
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${row.is_voided ? 'text-gray-500 line-through' : 'text-gray-900'}`}>
                        {isAdvance ? t('advances.advance') : t('advances.repayment')}
                        {row.note && <span className="text-gray-500 font-normal"> — {row.note}</span>}
                      </p>
                      <p className="text-xs text-gray-400">
                        {formatTimestamp(row.created_at)}
                        {row.is_voided && <span className="mx-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-700 uppercase tracking-wider">{t('advances.voided')}</span>}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`font-semibold tabular-nums ${row.is_voided ? 'text-gray-400 line-through' : isAdvance ? 'text-purple-700' : 'text-green-700'}`}>
                      {isAdvance ? '+' : '-'}{formatDZD(row.amount)}
                    </span>
                    {canVoidRow(row) && (
                      <button onClick={() => openVoidModal(row)} className="text-xs font-medium text-red-600 hover:text-red-800 bg-red-50 px-2 py-1 rounded">
                        {t('ledger.void')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {(page > 0 || hasMore) && (
        <div className="px-4 py-2 border-t border-gray-100 flex items-center justify-between text-xs text-gray-600">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50">
            <ChevronLeft size={14} className="rtl:rotate-180" /> {t('advances.prev')}
          </button>
          <span>{t('advances.page')} {page + 1}</span>
          <button onClick={() => setPage((p) => p + 1)} disabled={!hasMore || loading} className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-200 disabled:opacity-40 hover:bg-gray-50">
            {t('advances.next')} <ChevronRight size={14} className="rtl:rotate-180" />
          </button>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="flex justify-between items-center p-4 border-b border-gray-100 bg-gray-50">
              <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
                <Wallet size={20} className="text-purple-600" /> {t('advances.record_btn')}
              </h3>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
            </div>
            {formError && <div className="mx-4 mt-3 rounded-md bg-red-50 border border-red-200 p-3 text-sm text-red-700">{formError}</div>}
            <form onSubmit={handleSubmitAdvance} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('advances.amount_dzd')} <span className="text-red-500">*</span>
                </label>
                <input type="number" step="0.01" min={AMOUNT_MIN} max={AMOUNT_MAX} required value={formAmount} onChange={(e) => setFormAmount(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500" placeholder="0.00" autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('advances.note_optional')}
                </label>
                <textarea rows={3} maxLength={NOTE_MAX} value={formNote} onChange={(e) => setFormNote(e.target.value)} className="w-full rounded-md border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500" placeholder={t('advances.placeholder_note')} />
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={closeModal} disabled={submitting} className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50">{t('common.cancel')}</button>
                <button type="submit" disabled={submitting} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-purple-600 rounded-md hover:bg-purple-700 disabled:opacity-50">
                  <CheckCircle2 size={16} /> {submitting ? t('common.recording') : t('common.confirm')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rowToVoid && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-4 border-b border-gray-100 bg-red-50/50">
              <h3 className="font-bold text-lg text-red-700 flex items-center gap-2"><AlertTriangle size={20} /> {t('ledger.void_transaction_title')}</h3>
              <button onClick={closeVoidModal} className="text-gray-400 hover:text-gray-600 bg-white rounded-full p-1"><X size={20} /></button>
            </div>
            {voidError && <div className="mx-4 mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 font-medium">{voidError}</div>}
            <form onSubmit={submitVoid} className="p-6 space-y-4">
              <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 text-sm">
                <span className="text-gray-500 mx-2">{t('advances.amount_to_void')}</span>
                <span className="font-bold text-gray-900">{formatDZD(rowToVoid.amount)}</span>
              </div>
              <div>
                <label className="block text-sm font-bold text-gray-700 mb-1">{t('advances.reason_void')} <span className="text-red-500">*</span></label>
                <textarea rows={3} maxLength={500} required value={voidReason} onChange={(e) => setVoidReason(e.target.value)} className="w-full rounded-lg border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 resize-none" placeholder={t('advances.reason_placeholder')} autoFocus />
                <div className="flex justify-between mt-1 text-xs">
                  <span className="text-red-500 font-medium">{t('advances.required')}</span>
                  <span className="text-gray-500">{voidReason.length}/500</span>
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
                <button type="button" onClick={closeVoidModal} disabled={voidSubmitting} className="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors">{t('common.cancel')}</button>
                <button type="submit" disabled={voidSubmitting || !voidReason.trim()} className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:bg-red-400 transition-colors">
                  {voidSubmitting ? <><RefreshCw size={16} className="animate-spin" /> {t('advances.voiding')}</> : <><Ban size={16} /> {t('advances.confirm_void')}</>}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}