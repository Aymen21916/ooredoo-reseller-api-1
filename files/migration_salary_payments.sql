-- Salary payments: each row = one payment of (part of) a cashier's monthly salary.
-- Every payment is linked to a manual "out" row in register_ledger, so the money
-- is taken from the store's register cash. Run once on your database.

CREATE TABLE IF NOT EXISTS public.salary_payments (
    id                serial PRIMARY KEY,
    cashier_id        integer NOT NULL REFERENCES public.users(id)  ON DELETE RESTRICT,
    store_id          integer NOT NULL REFERENCES public.stores(id) ON DELETE RESTRICT,
    month             character varying(7) NOT NULL,           -- 'YYYY-MM'
    amount            numeric(12,2) NOT NULL,                  -- cash taken from the register
    advance_deducted  numeric(12,2) NOT NULL DEFAULT 0,        -- advance settled from the salary (no cash moves)
    note              character varying(500),
    ledger_id         integer NOT NULL REFERENCES public.register_ledger(id)  ON DELETE RESTRICT,
    repayment_id      integer          REFERENCES public.cashier_advances(id) ON DELETE RESTRICT,
    is_voided         boolean NOT NULL DEFAULT false,
    voided_at         timestamp with time zone,
    voided_by         integer REFERENCES public.users(id) ON DELETE RESTRICT,
    void_reason       character varying(500),
    created_by        integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
    created_at        timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT salary_payments_amount_check           CHECK (amount > 0),
    CONSTRAINT salary_payments_advance_deducted_check CHECK (advance_deducted >= 0),
    CONSTRAINT salary_payments_month_check            CHECK (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);

CREATE INDEX IF NOT EXISTS idx_salary_payments_cashier_month ON public.salary_payments (cashier_id, month);
CREATE INDEX IF NOT EXISTS idx_salary_payments_ledger        ON public.salary_payments (ledger_id);

COMMENT ON TABLE public.salary_payments IS 'Salary payments to cashiers, each linked to a register_ledger "out" entry.';
