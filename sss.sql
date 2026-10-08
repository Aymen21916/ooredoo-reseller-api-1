-- Run AFTER 002_card_payments.sql
-- Card (TPE) payments are sales that did not bring cash into the drawer, so they are
-- removed from expected_register_cash. A new column card_total (last column) exposes the amount.
-- Used by: close-shift screen, closeSession() discrepancy, admin live dashboard,
-- cashier history and the daily-report snapshot.
CREATE OR REPLACE VIEW public.v_session_live_totals AS
 SELECT cs.id AS session_id,
    cs.cashier_id,
    u.full_name AS cashier_name,
    cs.store_id,
    s.name AS store_name,
    cs.session_date,
    cs.opening_cash,
    COALESCE(sim.sim_units_sold, (0)::bigint) AS sim_units_sold,
    COALESCE(sim.sim_total_real_price, (0)::numeric) AS sim_total_real_price,
    COALESCE(sim.sim_total_selling_price, (0)::numeric) AS sim_total_selling_price,
    COALESCE(sim.sim_total_points, (0)::bigint) AS sim_total_points,
    COALESCE(sim.sim_total_commission, (0)::numeric) AS sim_total_commission,
    COALESCE(sim.sim_total_profit, (0)::numeric) AS sim_total_profit,
    COALESCE(storm.storm_total, (0)::numeric) AS storm_total,
    COALESCE(acc.accessories_total, (0)::numeric) AS accessories_total,
    COALESCE(acc.accessories_total_real_price, (0)::numeric) AS accessories_total_real_price,
    COALESCE(acc.accessories_total_commission, (0)::numeric) AS accessories_total_commission,
    COALESCE(acc.accessories_total_profit, (0)::numeric) AS accessories_total_profit,
    COALESCE(debt.debt_total, (0)::numeric) AS debt_total,
    COALESCE(exp.expense_total, (0)::numeric) AS expense_total,
    COALESCE(adv.advance_total, (0)::numeric) AS advance_total,
    (COALESCE(sim.sim_total_commission, (0)::numeric) + COALESCE(acc.accessories_total_commission, (0)::numeric)) AS total_cashier_benefit,
    ((COALESCE(sim.loyalty_points_redeemed, (0)::numeric) + COALESCE(storm.loyalty_points_redeemed, (0)::numeric)) + COALESCE(acc.loyalty_points_redeemed, (0)::numeric)) AS loyalty_points_redeemed,
    ((COALESCE(sim.loyalty_driven_revenue, (0)::numeric) + COALESCE(storm.loyalty_driven_revenue, (0)::numeric)) + COALESCE(acc.loyalty_driven_revenue, (0)::numeric)) AS loyalty_driven_revenue,
    ((((cs.opening_cash + COALESCE(sim.sim_total_selling_price, (0)::numeric)) + COALESCE(storm.storm_total, (0)::numeric)) + COALESCE(acc.accessories_total, (0)::numeric))
      - (((((((COALESCE(sim.loyalty_points_redeemed, (0)::numeric) + COALESCE(storm.loyalty_points_redeemed, (0)::numeric)) + COALESCE(acc.loyalty_points_redeemed, (0)::numeric))
            * COALESCE(( SELECT loyalty_settings.value
                           FROM public.loyalty_settings
                          WHERE ((loyalty_settings.key)::text = 'point_to_dzd_value'::text)
                         LIMIT 1), (1)::numeric))
           + COALESCE(debt.debt_total, (0)::numeric))
           + COALESCE(exp.expense_total, (0)::numeric))
           + COALESCE(adv.advance_total, (0)::numeric))
           + COALESCE(card.card_total, (0)::numeric))) AS expected_register_cash,
    COALESCE(card.card_total, (0)::numeric) AS card_total
   FROM (((((((((public.cashier_sessions cs
     JOIN public.users u ON ((u.id = cs.cashier_id)))
     JOIN public.stores s ON ((s.id = cs.store_id)))
     LEFT JOIN ( SELECT session_sim_sales.session_id,
            count(session_sim_sales.id) AS sim_units_sold,
            sum(session_sim_sales.real_price_snapshot) AS sim_total_real_price,
            sum(session_sim_sales.selling_price_snapshot) AS sim_total_selling_price,
            sum(session_sim_sales.commission_points_snapshot) AS sim_total_points,
            sum(session_sim_sales.commission_snapshot) AS sim_total_commission,
            sum((((session_sim_sales.commission_points_snapshot)::numeric + session_sim_sales.selling_price_snapshot) - session_sim_sales.real_price_snapshot)) AS sim_total_profit,
            sum(session_sim_sales.loyalty_redeemed_snapshot) AS loyalty_points_redeemed,
            sum(session_sim_sales.selling_price_snapshot) FILTER (WHERE (session_sim_sales.customer_id IS NOT NULL)) AS loyalty_driven_revenue
           FROM public.session_sim_sales
          WHERE (session_sim_sales.is_voided = false)
          GROUP BY session_sim_sales.session_id) sim ON ((sim.session_id = cs.id)))
     LEFT JOIN ( SELECT session_storm_entries.session_id,
            sum(session_storm_entries.amount) AS storm_total,
            sum(session_storm_entries.loyalty_redeemed_snapshot) AS loyalty_points_redeemed,
            sum(session_storm_entries.amount) FILTER (WHERE (session_storm_entries.customer_id IS NOT NULL)) AS loyalty_driven_revenue
           FROM public.session_storm_entries
          WHERE (session_storm_entries.is_voided = false)
          GROUP BY session_storm_entries.session_id) storm ON ((storm.session_id = cs.id)))
     LEFT JOIN ( SELECT session_accessory_sales.session_id,
            sum(session_accessory_sales.price_snapshot) AS accessories_total,
            sum(session_accessory_sales.real_price_snapshot) AS accessories_total_real_price,
            sum(session_accessory_sales.commission_snapshot) AS accessories_total_commission,
            sum((session_accessory_sales.price_snapshot - session_accessory_sales.real_price_snapshot)) AS accessories_total_profit,
            sum(session_accessory_sales.loyalty_redeemed_snapshot) AS loyalty_points_redeemed,
            sum(session_accessory_sales.price_snapshot) FILTER (WHERE (session_accessory_sales.customer_id IS NOT NULL)) AS loyalty_driven_revenue
           FROM public.session_accessory_sales
          WHERE (session_accessory_sales.is_voided = false)
          GROUP BY session_accessory_sales.session_id) acc ON ((acc.session_id = cs.id)))
     LEFT JOIN ( SELECT session_debts.session_id,
            sum(session_debts.amount) AS debt_total
           FROM public.session_debts
          WHERE (session_debts.is_voided = false)
          GROUP BY session_debts.session_id) debt ON ((debt.session_id = cs.id)))
     LEFT JOIN ( SELECT register_expenses.session_id,
            sum(register_expenses.amount) AS expense_total
           FROM public.register_expenses
          WHERE (register_expenses.is_voided = false)
          GROUP BY register_expenses.session_id) exp ON ((exp.session_id = cs.id)))
     LEFT JOIN ( SELECT cashier_advances.session_id,
            sum(cashier_advances.amount) AS advance_total
           FROM public.cashier_advances
          WHERE ((cashier_advances.is_voided = false) AND ((cashier_advances.direction)::text = 'advance'::text))
          GROUP BY cashier_advances.session_id) adv ON ((adv.session_id = cs.id))))
     LEFT JOIN ( SELECT session_card_payments.session_id,
            sum(session_card_payments.amount) AS card_total
           FROM public.session_card_payments
          WHERE (session_card_payments.is_voided = false)
          GROUP BY session_card_payments.session_id) card ON ((card.session_id = cs.id));