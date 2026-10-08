import { useState, useEffect, useMemo, useCallback } from 'react';
import api from '../../api/axios';
import {
  RefreshCw, AlertCircle, CheckCircle2, X, Banknote, Store, User, HandCoins, Ban, AlertTriangle, History,
} from 'lucide-react';

const formatDZD = (n) =>
  new Intl.NumberFormat('fr-DZ', {
    style: 'currency', currency: 'DZD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);

const formatDateTime = (s) =>
  s
    ? new Date(s).toLocaleString('en-GB', {
        year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : '—';

const pad = (n) => String(n).padStart(2, '0');
const currentMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Payroll for one month: who earned what, what was already paid, and the
 * "Record payment" button that takes the cash out of the cashier's store register.
 *
 * Props:
 *   refreshKey — change it to reload (e.g. after an advance repayment elsewhere on the page)
 *   onChanged  — called after a payment is recorded or voided (the advances list reloads)
 */
export default function PayrollSection({ refreshKey = 0, onChanged }) {
  const [month, setMonth] = useState(currentMonth());
  const [data, setData] = useState({ items: [], payments: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [payTarget, setPayTarget] = useState(null);
  const [voidTarget, setVoidTarget] = useState(null);

  const flash = (msg) => { setSuccess(msg); setTimeout(() => setSuccess(''), 5000); };

  const fetchPayroll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/advances/salary', { params: { month } });
      const d = r.data.data || {};
      setData({ items: d.items || [], payments: d.payments || [] });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load salaries.');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { fetchPayroll(); }, [fetchPayroll, refreshKey]);

  const afterChange = () => { fetchPayroll(); onChanged?.(); };

  const totals = useMemo(() => {
    const items = data.items || [];
    return {
      total: items.reduce((s, r) => s + (r.total_salary || 0), 0),
      paid: items.reduce((s, r) => s + (r.amount_paid || 0) + (r.advance_deducted || 0), 0),
      remaining: items.reduce((s, r) => s + (r.remaining_salary || 0), 0),
    };
  }, [data]);

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

      {/* Month + KPIs */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <label className="block text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Month</label>
          <input
            type="month" value={month} max={currentMonth()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
          />
        </div>
        <div className="flex flex-wrap gap-3">
          <Kpi label="Total payroll" value={formatDZD(totals.total)} accent="text-gray-900" />
          <Kpi label="Already paid" value={formatDZD(totals.paid)} accent="text-green-700" />
          <Kpi label="Still to pay" value={formatDZD(totals.remaining)} accent="text-red-600" />
        </div>
      </div>

      {/* Salaries table */}
      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className={`${th} text-left`}>Cashier</th>
              <th className={`${th} text-right`}>Base salary</th>
              <th className={`${th} text-right`}>SIM commission</th>
              <th className={`${th} text-right`}>Accessory commission</th>
              <th className={`${th} text-right`}>App commission</th>
              <th className={`${th} text-right`}>Total salary</th>
              <th className={`${th} text-right`}>Advance owed</th>
              <th className={`${th} text-right`}>Already paid</th>
              <th className={`${th} text-right`}>Left to pay</th>
              <th className={`${th} text-right`}>Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {loading ? (
              <tr><td colSpan="10" className="px-4 py-8 text-center"><RefreshCw className="inline animate-spin text-red-600" /></td></tr>
            ) : data.items.length === 0 ? (
              <tr><td colSpan="10" className="px-4 py-8 text-center text-gray-500">No active cashiers found.</td></tr>
            ) : (
              data.items.map((r) => (
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
                  <td className="px-3 py-3 text-right whitespace-nowrap font-semibold text-gray-900">{formatDZD(r.base_salary)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {formatDZD(r.sim_commission)}
                    <div className="text-xs text-gray-400">{r.sim_units} SIM</div>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {formatDZD(r.accessory_commission)}
                    <div className="text-xs text-gray-400">{r.accessory_units} sold</div>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {r.app_commission_enabled
                      ? <span className="font-semibold text-gray-900">+{formatDZD(r.app_commission)}</span>
                      : <span className="text-gray-400 line-through">{formatDZD(r.app_commission_earned)}</span>}
                    <div className="text-xs text-gray-400">{r.app_installs} installs{r.app_commission_enabled ? '' : ' · not counted'}</div>
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap font-extrabold text-gray-900">{formatDZD(r.total_salary)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap text-orange-700">{formatDZD(r.outstanding_advance)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap text-green-700">
                    {formatDZD(r.amount_paid)}
                    {r.advance_deducted > 0 && (
                      <div className="text-xs text-gray-400">+ {formatDZD(r.advance_deducted)} advance deducted</div>
                    )}
                  </td>
                  <td className={`px-3 py-3 text-right whitespace-nowrap font-bold ${r.remaining_salary > 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {formatDZD(r.remaining_salary)}
                  </td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => setPayTarget(r)}
                      disabled={r.remaining_salary <= 0}
                      className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={r.remaining_salary <= 0 ? 'Fully paid for this month.' : 'Pay this salary from the store register.'}
                    >
                      <HandCoins size={14} /> Record payment
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500">
        Total salary = base salary + SIM commission + accessory commission + app commission (only when enabled in Settings).
        Voided sales are excluded. “Record payment” takes the money out of the cashier’s store register.
      </p>

      {/* Payment history */}
      <div>
        <h4 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1">
          <History size={14} /> Payments of {month}
        </h4>
        {data.payments.length === 0 ? (
          <div className="text-sm text-gray-500 italic py-4 border border-dashed border-gray-200 rounded-md text-center">
            No salary payment recorded for this month.
          </div>
        ) : (
          <div className="rounded-md border border-gray-200 overflow-x-auto bg-white">
            <table className="min-w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">When</th>
                  <th className="px-2 py-1.5 text-left font-medium">Cashier</th>
                  <th className="px-2 py-1.5 text-right font-medium">Cash paid</th>
                  <th className="px-2 py-1.5 text-right font-medium">Advance deducted</th>
                  <th className="px-2 py-1.5 text-left font-medium">Note</th>
                  <th className="px-2 py-1.5 text-left font-medium">By</th>
                  <th className="px-2 py-1.5 text-center font-medium">Status</th>
                  <th className="px-2 py-1.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.payments.map((p) => (
                  <tr key={p.id} className={p.is_voided ? 'bg-red-50/40 text-gray-400' : ''}>
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatDateTime(p.created_at)}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.cashier_name}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${p.is_voided ? 'line-through' : ''}`}>{formatDZD(p.amount)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono ${p.is_voided ? 'line-through' : ''}`}>{formatDZD(p.advance_deducted)}</td>
                    <td className="px-2 py-1.5 truncate max-w-xs">{p.note || '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{p.paid_by_name || '—'}</td>
                    <td className="px-2 py-1.5 text-center">
                      {p.is_voided ? (
                        <span className="inline-flex rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700" title={p.void_reason || ''}>Voided</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-green-100 px-1.5 text-xs font-semibold text-green-700">Paid</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      {!p.is_voided && (
                        <button
                          onClick={() => setVoidTarget(p)}
                          className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-1 font-medium text-red-600 hover:text-red-800"
                        >
                          <Ban size={12} /> Void
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {payTarget && (
        <RecordPaymentModal
          target={payTarget}
          month={month}
          onClose={() => setPayTarget(null)}
          onDone={(msg) => { setPayTarget(null); flash(msg); afterChange(); }}
        />
      )}
      {voidTarget && (
        <VoidPaymentModal
          payment={voidTarget}
          onClose={() => setVoidTarget(null)}
          onDone={() => { setVoidTarget(null); flash('Payment voided. The money is back in the register.'); afterChange(); }}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div className="rounded-lg bg-white border border-gray-200 p-3 flex items-center gap-3">
      <Banknote size={18} className="text-red-600" />
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
        <div className={`text-lg font-bold ${accent}`}>{value}</div>
      </div>
    </div>
  );
}

function RecordPaymentModal({ target, month, onClose, onDone }) {
  const canDeduct = target.advance_deductible > 0;
  const [deduct, setDeduct] = useState(canDeduct);
  const maxCash = round2(target.remaining_salary - (deduct ? target.advance_deductible : 0));
  const [amount, setAmount] = useState(String(maxCash));
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [registerBalance, setRegisterBalance] = useState(null);

  // When the "deduct advance" box changes, the default amount follows.
  const toggleDeduct = (checked) => {
    setDeduct(checked);
    setAmount(String(round2(target.remaining_salary - (checked ? target.advance_deductible : 0))));
    setError(''); setRegisterBalance(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    const raw = String(amount).trim();
    if (!AMOUNT_RE.test(raw) || Number(raw) < 0.01) { setError('Enter a valid amount (at least 0.01, up to 2 decimals).'); return; }
    if (Number(raw) > maxCash + 0.001) { setError(`The maximum you can pay now is ${formatDZD(maxCash)}.`); return; }

    setSubmitting(true); setError(''); setRegisterBalance(null);
    try {
      const r = await api.post('/advances/salary/payments', {
        cashier_id: target.cashier_id,
        month,
        amount: Number(raw),
        deduct_advance: deduct,
        note: note.trim() || undefined,
      });
      const d = r.data.data;
      onDone(
        `Paid ${formatDZD(d.amount)} to ${target.cashier_name} from the register` +
        (d.advance_deducted > 0 ? ` (+ ${formatDZD(d.advance_deducted)} advance deducted)` : '') +
        `. Register balance: ${formatDZD(d.register_balance_after)}.`
      );
    } catch (err) {
      const body = err.response?.data || {};
      if (body.code === 'INSUFFICIENT_REGISTER_CASH') {
        setRegisterBalance(Number(body.current_balance) || 0);
        setError('Not enough cash in the register of this store.');
      } else {
        setError(body.message || 'Failed to record the payment.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 p-4">
          <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
            <HandCoins className="text-green-600" size={20} /> Record payment
          </h3>
          <button onClick={() => !submitting && onClose()} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>

        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="rounded-md bg-gray-50 p-3 border border-gray-200 space-y-1 text-sm">
            <div className="font-semibold text-gray-900">{target.cashier_name} · {month}</div>
            <div className="text-xs text-gray-500 flex items-center gap-1"><Store size={12} /> {target.store_name || '—'}</div>
            <Row label="Total salary" value={formatDZD(target.total_salary)} />
            <Row label="Already paid" value={formatDZD(target.amount_paid + target.advance_deducted)} />
            <Row label="Left to pay" value={formatDZD(target.remaining_salary)} bold />
            <Row label="Advance owed" value={formatDZD(target.outstanding_advance)} accent="text-orange-700" />
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <div>{error}</div>
                {registerBalance !== null && (
                  <div className="mt-1 text-xs flex items-center gap-1">
                    <AlertTriangle size={12} /> Cash in register: <strong>{formatDZD(registerBalance)}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          {canDeduct && (
            <label className="flex items-start gap-2 cursor-pointer select-none rounded-md border border-orange-200 bg-orange-50 p-3">
              <input
                type="checkbox" checked={deduct} onChange={(e) => toggleDeduct(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-red-600 focus:ring-red-500"
              />
              <span className="text-sm text-gray-800">
                Deduct the advance ({formatDZD(target.advance_deductible)}) from this salary
                <span className="block text-xs text-gray-500">No cash leaves the register for this part.</span>
              </span>
            </label>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Cash taken from the register (DZD) <span className="text-red-600">*</span>
            </label>
            <input
              type="number" required min="0.01" max={maxCash} step="0.01" autoFocus
              value={amount} onChange={(e) => { setAmount(e.target.value); setRegisterBalance(null); }}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm font-bold focus:border-red-500 focus:ring-red-500"
            />
            <p className="mt-1 text-xs text-gray-500">Maximum {formatDZD(maxCash)}. You can pay in several times.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <textarea
              rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
              placeholder="e.g. Salary of the month, paid in cash"
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button type="button" onClick={onClose} disabled={submitting}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50">
              <CheckCircle2 size={16} /> {submitting ? 'Saving...' : 'Confirm payment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Row({ label, value, bold, accent = 'text-gray-900' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`${bold ? 'font-bold' : 'font-medium'} ${accent}`}>{value}</span>
    </div>
  );
}

function VoidPaymentModal({ payment, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (trimmed.length < 1 || trimmed.length > 500) { setError('Reason must be between 1 and 500 characters.'); return; }
    setSubmitting(true); setError('');
    try {
      await api.post(`/advances/salary/payments/${payment.id}/void`, { reason: trimmed });
      onDone();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to void the payment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 bg-red-50/50 p-4">
          <h3 className="font-bold text-lg text-red-700 flex items-center gap-2"><AlertTriangle size={20} /> Void salary payment</h3>
          <button onClick={() => !submitting && onClose()} className="text-gray-400 hover:text-gray-600"><X size={20} /></button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="bg-gray-50 p-3 rounded-lg border border-gray-200 text-sm space-y-1">
            <div><span className="text-gray-500">Cashier:</span> <span className="font-semibold">{payment.cashier_name}</span></div>
            <div><span className="text-gray-500">Cash paid:</span> <span className="font-bold">{formatDZD(payment.amount)}</span> — it goes back into the register.</div>
            {payment.advance_deducted > 0 && (
              <div><span className="text-gray-500">Advance deducted:</span> <span className="font-bold">{formatDZD(payment.advance_deducted)}</span> — the advance is owed again.</div>
            )}
          </div>
          {error && <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          <div>
            <label className="block text-sm font-bold text-gray-700 mb-1">Reason <span className="text-red-500">*</span></label>
            <textarea
              rows={3} maxLength={500} required autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500 resize-none"
            />
            <div className="text-right text-xs text-gray-500">{reason.length}/500</div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button type="button" onClick={onClose} disabled={submitting}
              className="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={submitting || !reason.trim()}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:bg-red-400">
              <Ban size={16} /> {submitting ? 'Voiding...' : 'Confirm void'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
