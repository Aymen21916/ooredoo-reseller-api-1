import { useState, useEffect, useMemo } from 'react';
import api from '../../api/axios';
import PayrollSection from './PayrollSection';
import PayrollSettings from './PayrollSettings';
import {
  Wallet, RefreshCw, X, AlertCircle, CheckCircle2, Search, Store,
  User, ArrowDownCircle, ArrowUpCircle, Banknote, History,
} from 'lucide-react';

// ─── Formatting helpers ────────────────────────────────────────────────────

const formatDZD = (n) =>
  new Intl.NumberFormat('fr-DZ', {
    style: 'currency', currency: 'DZD', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(Number(n) || 0);

const formatDateTime = (s) =>
  s
    ? new Date(s).toLocaleString('en-GB', {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      })
    : '—';

const formatRelative = (s) => {
  if (!s) return 'Never';
  const ms = Date.now() - new Date(s).getTime();
  const mins  = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (mins  < 1)   return 'Just now';
  if (mins  < 60)  return `${mins}m ago`;
  if (hours < 24)  return `${hours}h ago`;
  if (days  < 30)  return `${days}d ago`;
  return formatDateTime(s);
};

// ─── Top-level page ────────────────────────────────────────────────────────

export default function AdminAdvances() {
  const [rows, setRows]         = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [search, setSearch]     = useState('');

  // Selected cashier drill-down state
  const [selectedId, setSelectedId] = useState(null);
  const [details, setDetails]       = useState(null); // { cashier, outstanding_balance, items, ... }
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [tab, setTab] = useState('payroll');
  // Bumped when advances change so the payroll table ("Advance owed") reloads too.
  const [payrollKey, setPayrollKey] = useState(0);

  // Repayment modal state — shared between the table row action and the
  // drill-down panel "Record repayment" button.
  const [repaymentTarget, setRepaymentTarget] = useState(null); // row from list
  const [repayForm, setRepayForm]             = useState({ amount: '', note: '' });
  const [repayError, setRepayError]           = useState('');
  const [repayCurrentBalance, setRepayCurrentBalance] = useState(null); // shown on REPAYMENT_EXCEEDS_BALANCE
  const [repaySubmitting, setRepaySubmitting] = useState(false);

  const fetchList = async () => {
    setLoading(true);
    setError('');
    try {
      const r = await api.get('/advances');
      // The API already sorts by outstanding_balance DESC; sort defensively
      // here too in case the underlying contract changes.
      const data = Array.isArray(r.data.data) ? [...r.data.data] : [];
      data.sort((a, b) => (b.outstanding_balance || 0) - (a.outstanding_balance || 0));
      setRows(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load cashier balances.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchList(); }, []);

  const openDrilldown = async (row) => {
    setSelectedId(row.cashier_id);
    setDetails(null);
    setDetailsLoading(true);
    try {
      const r = await api.get(`/advances/cashier/${row.cashier_id}`);
      setDetails(r.data.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load cashier history.');
      setSelectedId(null);
    } finally {
      setDetailsLoading(false);
    }
  };

  const closeDrilldown = () => {
    setSelectedId(null);
    setDetails(null);
  };

  const openRepayment = (row) => {
    setRepaymentTarget(row);
    setRepayForm({ amount: '', note: '' });
    setRepayError('');
    setRepayCurrentBalance(null);
  };

  const closeRepayment = () => {
    setRepaymentTarget(null);
    setRepayForm({ amount: '', note: '' });
    setRepayError('');
    setRepayCurrentBalance(null);
  };

  const submitRepayment = async (e) => {
    e.preventDefault();
    if (!repaymentTarget) return;

    const amount = Number(repayForm.amount);
    if (!Number.isFinite(amount) || amount < 0.01) {
      setRepayError('Enter an amount greater than or equal to 0.01 DZD.');
      return;
    }

    setRepaySubmitting(true);
    setRepayError('');
    setRepayCurrentBalance(null);
    try {
      const r = await api.post('/advances/repayment', {
        cashier_id: repaymentTarget.cashier_id,
        amount,
        note: repayForm.note.trim() || undefined,
      });
      const updated = r.data.data;
      setSuccess(
        `Repayment of ${formatDZD(amount)} recorded for ${repaymentTarget.cashier_name}. ` +
        `New outstanding balance: ${formatDZD(updated.outstanding_balance)}.`
      );
      setTimeout(() => setSuccess(''), 4500);
      closeRepayment();
      // Refresh the list and, if the drill-down is open for this cashier,
      // refresh the drill-down too so the new repayment row appears.
      fetchList();
      setPayrollKey((k) => k + 1);
      if (selectedId === repaymentTarget.cashier_id) {
        const drillRes = await api.get(`/advances/cashier/${selectedId}`);
        setDetails(drillRes.data.data);
      }
    } catch (err) {
      const body = err.response?.data || {};
      if (body.code === 'REPAYMENT_EXCEEDS_BALANCE' && typeof body.current_balance === 'number') {
        setRepayCurrentBalance(body.current_balance);
        setRepayError(
          `Repayment exceeds the cashier's outstanding balance ` +
          `(${formatDZD(body.current_balance)}).`
        );
      } else {
        setRepayError(body.message || 'Failed to record repayment.');
      }
    } finally {
      setRepaySubmitting(false);
    }
  };

  // ─── Filtering ──────────────────────────────────────────────────────────
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      (r.cashier_name || '').toLowerCase().includes(q) ||
      (r.store_name || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const totals = useMemo(() => {
    const totalOutstanding = rows.reduce((s, r) => s + (Number(r.outstanding_balance) || 0), 0);
    const cashiersWithDebt = rows.filter((r) => (Number(r.outstanding_balance) || 0) > 0).length;
    return { totalOutstanding, cashiersWithDebt, totalCashiers: rows.length };
  }, [rows]);

  // ─── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between border-b border-gray-200 pb-4">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Wallet className="text-red-600" /> Payroll & Advances
        </h1>
        <button
          onClick={() => { fetchList(); setPayrollKey((k) => k + 1); }}
          className="flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 hover:bg-gray-50"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-700 flex items-start gap-2">
          <CheckCircle2 size={18} className="mt-0.5 flex-shrink-0" />
          <span>{success}</span>
        </div>
      )}

      <div className="flex gap-2 border-b border-gray-200">
        {[['payroll', 'Payroll & Advances'], ['settings', 'Settings']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-bold border-b-2 -mb-px transition-colors ${
              tab === key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'payroll' && (<>

      {/* Payroll (salaries, "Record payment" from the register cash) */}
      <PayrollSection refreshKey={payrollKey} onChanged={fetchList} />

      {/* Advances */}
      <div className="border-t border-gray-200 pt-6">
        <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
          <Wallet size={18} className="text-red-600" /> Cashier advances
        </h2>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <KpiCard
          icon={<Banknote size={18} />}
          label="Total outstanding"
          value={formatDZD(totals.totalOutstanding)}
          accent="text-red-600"
        />
        <KpiCard
          icon={<User size={18} />}
          label="Cashiers with balance"
          value={`${totals.cashiersWithDebt} / ${totals.totalCashiers}`}
          accent="text-gray-900"
        />
        <KpiCard
          icon={<History size={18} />}
          label="Sorted by"
          value="Outstanding desc"
          accent="text-gray-900"
        />
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder="Search by cashier or store..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-md border border-gray-300 pl-9 pr-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
        />
      </div>

      {/* Cashier list */}
      <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200 overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Cashier</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Store</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Outstanding</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last activity</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {loading ? (
              <tr>
                <td colSpan="5" className="px-4 py-8 text-center">
                  <RefreshCw className="inline animate-spin text-red-600" />
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan="5" className="px-4 py-8 text-center text-sm text-gray-500">
                  {search ? 'No cashiers match your search.' : 'No active cashiers found.'}
                </td>
              </tr>
            ) : (
              visibleRows.map((r) => (
                <tr
                  key={r.cashier_id}
                  onClick={() => openDrilldown(r)}
                  className="hover:bg-gray-50 cursor-pointer"
                >
                  <td className="px-4 py-3 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <div className="h-8 w-8 rounded-full bg-gray-100 flex items-center justify-center">
                        <User size={16} className="text-gray-500" />
                      </div>
                      <div className="text-sm font-medium text-gray-900">{r.cashier_name}</div>
                    </div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                    <span className="inline-flex items-center gap-1">
                      <Store size={14} className="text-gray-400" />
                      {r.store_name || '—'}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right">
                    <BalancePill amount={Number(r.outstanding_balance) || 0} />
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600">
                    <span title={r.last_activity_at ? formatDateTime(r.last_activity_at) : ''}>
                      {formatRelative(r.last_activity_at)}
                    </span>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                    <button
                      onClick={(e) => { e.stopPropagation(); openRepayment(r); }}
                      disabled={(Number(r.outstanding_balance) || 0) <= 0}
                      className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                      title={
                        (Number(r.outstanding_balance) || 0) <= 0
                          ? 'No outstanding balance to repay.'
                          : 'Record repayment for this cashier.'
                      }
                    >
                      <ArrowDownCircle size={14} /> Record repayment
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      </>)}

      {tab === 'settings' && <PayrollSettings />}

      {/* Drill-down modal */}
      {selectedId !== null && (
        <DrilldownModal
          loading={detailsLoading}
          details={details}
          onClose={closeDrilldown}
          onRecordRepayment={() => {
            // Synthesize a list-row shape from the loaded details so the
            // repayment modal can use a consistent target object.
            if (!details) return;
            openRepayment({
              cashier_id:           details.cashier.id,
              cashier_name:         details.cashier.full_name,
              store_id:             details.cashier.store_id,
              store_name:           details.cashier.store_name,
              outstanding_balance:  details.outstanding_balance,
            });
          }}
        />
      )}

      {/* Repayment modal */}
      {repaymentTarget && (
        <RepaymentModal
          target={repaymentTarget}
          form={repayForm}
          setForm={setRepayForm}
          submitting={repaySubmitting}
          error={repayError}
          currentBalance={repayCurrentBalance}
          onSubmit={submitRepayment}
          onClose={closeRepayment}
        />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function KpiCard({ icon, label, value, accent = 'text-gray-900' }) {
  return (
    <div className="rounded-lg bg-white border border-gray-200 p-3 flex items-center gap-3">
      <div className="text-red-600">{icon}</div>
      <div>
        <div className="text-xs text-gray-500 uppercase tracking-wider">{label}</div>
        <div className={`text-xl font-bold ${accent}`}>{value}</div>
      </div>
    </div>
  );
}

function BalancePill({ amount }) {
  if (amount <= 0) {
    return (
      <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
        {formatDZD(0)}
      </span>
    );
  }
  return (
    <span className="inline-flex rounded-full bg-red-100 px-2 py-0.5 text-sm font-bold text-red-800">
      {formatDZD(amount)}
    </span>
  );
}

function DirectionBadge({ direction }) {
  if (direction === 'advance') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 px-2 py-0.5 text-xs font-semibold text-orange-800">
        <ArrowUpCircle size={12} /> Advance
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-800">
      <ArrowDownCircle size={12} /> Repayment
    </span>
  );
}

function DrilldownModal({ loading, details, onClose, onRecordRepayment }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 p-4">
          <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
            <Wallet className="text-red-600" size={20} /> Cashier advance ledger
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <div className="p-6 overflow-y-auto space-y-6">
          {loading || !details ? (
            <div className="flex justify-center py-12">
              <RefreshCw className="animate-spin text-red-600" size={28} />
            </div>
          ) : (
            <>
              {/* Identity + balance */}
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="space-y-1">
                  <div className="text-2xl font-bold text-gray-900">
                    {details.cashier.full_name}
                  </div>
                  <div className="text-sm text-gray-600 flex items-center gap-1">
                    <Store size={14} /> {details.cashier.store_name || '—'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wider text-gray-500">
                    Outstanding balance
                  </div>
                  <div className={`text-3xl font-extrabold ${
                    (Number(details.outstanding_balance) || 0) > 0
                      ? 'text-red-600'
                      : 'text-green-600'
                  }`}>
                    {formatDZD(details.outstanding_balance)}
                  </div>
                  <button
                    onClick={onRecordRepayment}
                    disabled={(Number(details.outstanding_balance) || 0) <= 0}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <ArrowDownCircle size={14} /> Record repayment
                  </button>
                </div>
              </div>

              {/* History table */}
              <div>
                <h4 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-1">
                  <History size={14} /> Recent activity
                </h4>
                {details.items.length === 0 ? (
                  <div className="text-sm text-gray-500 italic py-4 border border-dashed border-gray-200 rounded-md text-center">
                    No advance or repayment activity yet.
                  </div>
                ) : (
                  <div className="rounded-md border border-gray-200 overflow-x-auto">
                    <table className="min-w-full text-xs">
                      <thead className="bg-gray-50 text-gray-500">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-medium">When</th>
                          <th className="px-2 py-1.5 text-left font-medium">Direction</th>
                          <th className="px-2 py-1.5 text-right font-medium">Amount</th>
                          <th className="px-2 py-1.5 text-left font-medium">Note</th>
                          <th className="px-2 py-1.5 text-center font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {details.items.map((row) => (
                          <tr key={row.id} className={row.is_voided ? 'bg-red-50/40 text-gray-400' : ''}>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              {formatDateTime(row.created_at)}
                            </td>
                            <td className="px-2 py-1.5 whitespace-nowrap">
                              <DirectionBadge direction={row.direction} />
                            </td>
                            <td className={`px-2 py-1.5 text-right font-mono ${
                              row.is_voided ? 'line-through' : ''
                            }`}>
                              {formatDZD(row.amount)}
                            </td>
                            <td className="px-2 py-1.5 truncate max-w-xs">{row.note || '—'}</td>
                            <td className="px-2 py-1.5 text-center">
                              {row.is_voided ? (
                                <span
                                  className="inline-flex rounded-full bg-red-100 px-1.5 text-xs font-semibold text-red-700"
                                  title={row.void_reason || ''}
                                >
                                  Voided
                                </span>
                              ) : (
                                <span className="inline-flex rounded-full bg-green-100 px-1.5 text-xs font-semibold text-green-700">
                                  Active
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function RepaymentModal({
  target, form, setForm, submitting, error, currentBalance, onSubmit, onClose,
}) {
  const setField = (name) => (e) => setForm((f) => ({ ...f, [name]: e.target.value }));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50 p-4">
          <h3 className="font-bold text-lg text-gray-900 flex items-center gap-2">
            <ArrowDownCircle className="text-green-600" size={20} /> Record repayment
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={onSubmit} className="p-6 space-y-4">
          <div className="rounded-md bg-gray-50 p-3 border border-gray-200">
            <div className="text-xs uppercase tracking-wider text-gray-500">Cashier</div>
            <div className="font-semibold text-gray-900">{target.cashier_name}</div>
            <div className="text-xs text-gray-500 flex items-center gap-1 mt-1">
              <Store size={12} /> {target.store_name || '—'}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <span className="text-xs uppercase tracking-wider text-gray-500">Outstanding</span>
              <span className="font-bold text-red-600">{formatDZD(target.outstanding_balance)}</span>
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <div>{error}</div>
                {currentBalance !== null && (
                  <div className="mt-1 text-xs">
                    Current balance: <strong>{formatDZD(currentBalance)}</strong>
                  </div>
                )}
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Amount (DZD) <span className="text-red-600">*</span>
            </label>
            <input
              type="number"
              required
              min="0.01"
              max={Number(target.outstanding_balance) || undefined}
              step="0.01"
              value={form.amount}
              onChange={setField('amount')}
              autoFocus
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
              placeholder="0.00"
            />
            <p className="mt-1 text-xs text-gray-500">
              Maximum {formatDZD(target.outstanding_balance)} (current outstanding balance).
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <textarea
              rows={2}
              maxLength={500}
              value={form.note}
              onChange={setField('note')}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-red-500 focus:ring-red-500"
              placeholder="e.g. Repaid in cash on shift end..."
            />
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-green-600 rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              <CheckCircle2 size={16} />
              {submitting ? 'Saving...' : 'Confirm repayment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
