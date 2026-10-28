-- =====================================================================
-- OPTIONAL demo data for trying the noodle factory system.
-- Everything is tagged so it can be removed in one go (see bottom).
-- Replace with your real materials / products / customers later.
-- =====================================================================

insert into noodle.suppliers (id, name, contact, phone, notes) values
 ('a0000000-0000-0000-0000-000000000001', 'Demo Malom Kft', 'Kovács Péter', '+36 1 000 0001', 'DEMO'),
 ('a0000000-0000-0000-0000-000000000002', 'Demo Asia Food', 'Wang Li', '+36 1 000 0002', 'DEMO'),
 ('a0000000-0000-0000-0000-000000000003', 'Demo Csomagolás', null, null, 'DEMO');

insert into noodle.materials (id, code, name_zh, name_en, name_hu, category, unit, cost_per_unit, min_stock, default_supplier_id, allergens) values
 ('b0000000-0000-0000-0000-000000000001', 'M-FL1', '高筋面粉', 'Bread flour', 'Kenyérliszt BL80', '面粉', 'kg', 320, 300, 'a0000000-0000-0000-0000-000000000001', '{gluten}'),
 ('b0000000-0000-0000-0000-000000000002', 'M-FL2', '中筋面粉', 'All-purpose flour', 'Finomliszt BL55', '面粉', 'kg', 260, 150, 'a0000000-0000-0000-0000-000000000001', '{gluten}'),
 ('b0000000-0000-0000-0000-000000000003', 'M-KAN', '碱水粉', 'Kansui powder', 'Kansui por', '辅料', 'kg', 4200, 5, 'a0000000-0000-0000-0000-000000000002', '{}'),
 ('b0000000-0000-0000-0000-000000000004', 'M-SALT', '盐', 'Salt', 'Só', '辅料', 'kg', 180, 20, 'a0000000-0000-0000-0000-000000000002', '{}'),
 ('b0000000-0000-0000-0000-000000000005', 'M-EGG', '鸡蛋液', 'Liquid egg', 'Folyékony tojás', '蛋', 'l', 1500, 10, 'a0000000-0000-0000-0000-000000000001', '{egg}'),
 ('b0000000-0000-0000-0000-000000000006', 'M-STA', '手粉（土豆淀粉）', 'Potato starch (dusting)', 'Burgonyakeményítő', '辅料', 'kg', 650, 15, 'a0000000-0000-0000-0000-000000000002', '{}'),
 ('b0000000-0000-0000-0000-000000000007', 'M-BAG', '真空袋 20×30', 'Vacuum bag 20×30', 'Vákuumtasak 20×30', '包装', 'pcs', 18, 2000, 'a0000000-0000-0000-0000-000000000003', '{}');

insert into noodle.products (id, code, name_zh, name_en, name_hu, unit, pack_size_g, shelf_life_days, storage, batch_yield, base_price, min_order_qty, sort, description) values
 ('c0000000-0000-0000-0000-000000000001', 'N-THIN', '细拉面', 'Thin ramen noodles', 'Vékony ramen tészta', 'kg', 130, 5, '0–4 °C', 25, 1400, 5, 1, 'Hakata style, 1.1 mm'),
 ('c0000000-0000-0000-0000-000000000002', 'N-THICK', '粗拉面', 'Thick ramen noodles', 'Vastag ramen tészta', 'kg', 160, 5, '0–4 °C', 25, 1400, 5, 2, 'For miso / tsukemen, 2 mm'),
 ('c0000000-0000-0000-0000-000000000003', 'N-WAVY', '卷曲面', 'Wavy noodles', 'Hullámos tészta', 'kg', 150, 5, '0–4 °C', 25, 1500, 5, 3, null),
 ('c0000000-0000-0000-0000-000000000004', 'N-UDON', '乌冬面', 'Udon', 'Udon tészta', 'kg', 220, 4, '0–4 °C', 20, 1200, 5, 4, null),
 ('c0000000-0000-0000-0000-000000000005', 'N-WRAP', '饺子皮', 'Dumpling wrappers', 'Gombóctészta lap', 'pack', 500, 3, '0–4 °C', 40, 900, 2, 5, '500 g pack, ~45 pcs');

insert into noodle.recipe_lines (product_id, material_id, qty_per_batch, sort) values
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 18, 0),
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000003', 0.25, 1),
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004', 0.2, 2),
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000006', 0.6, 3),
 ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000007', 190, 4),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000001', 17, 0),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000003', 0.3, 1),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000004', 0.2, 2),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000005', 1.5, 3),
 ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000006', 0.6, 4),
 ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000001', 17.5, 0),
 ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003', 0.28, 1),
 ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000005', 1, 2),
 ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 13, 0),
 ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', 0.5, 1),
 ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 14, 0),
 ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000004', 0.1, 1);

insert into noodle.customers (id, name, type, contact_person, phone, address, delivery_notes) values
 ('d0000000-0000-0000-0000-000000000001', 'DEMO 自家餐厅 1', 'internal', null, null, 'Budapest, Demo utca 1.', '后门卸货'),
 ('d0000000-0000-0000-0000-000000000002', 'DEMO 自家餐厅 2', 'internal', null, null, 'Budapest, Demo utca 2.', null),
 ('d0000000-0000-0000-0000-000000000003', 'DEMO Ramen Bar', 'wholesale', 'Nagy Anna', '+36 30 000 0003', 'Budapest, Demo körút 3.', '10:00 前送到');

insert into noodle.customer_prices (customer_id, product_id, price) values
 ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 1050),
 ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 1050),
 ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 1050),
 ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 1300);

-- opening stock
insert into noodle.stock_movements (material_id, qty, reason, note) values
 ('b0000000-0000-0000-0000-000000000001', 220, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000002', 180, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000003', 3.5, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000004', 40, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000005', 18, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000006', 25, 'count', 'DEMO opening stock'),
 ('b0000000-0000-0000-0000-000000000007', 1500, 'count', 'DEMO opening stock');
insert into noodle.stock_movements (product_id, qty, reason, note) values
 ('c0000000-0000-0000-0000-000000000001', 12, 'count', 'DEMO opening stock'),
 ('c0000000-0000-0000-0000-000000000004', 8, 'count', 'DEMO opening stock');

-- a few orders for tomorrow
insert into noodle.orders (id, customer_id, status, delivery_date, notes) values
 ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'confirmed', current_date + 1, null),
 ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'confirmed', current_date + 1, null),
 ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'submitted', current_date + 1, 'DEMO');
insert into noodle.order_lines (order_id, product_id, qty, unit_price) values
 ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 20, 1050),
 ('e0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002', 10, 1050),
 ('e0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', 15, 1050),
 ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', 25, 1300),
 ('e0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000004', 10, 1200);

-- ---------------------------------------------------------------------
-- Remove ALL demo data later (run as one block):
--
-- delete from noodle.stock_movements where note like 'DEMO%'
--    or material_id::text like 'b0000000%' or product_id::text like 'c0000000%';
-- delete from noodle.orders where customer_id::text like 'd0000000%';
-- delete from noodle.production_batches where product_id::text like 'c0000000%';
-- delete from noodle.purchase_orders where supplier_id::text like 'a0000000%';
-- delete from noodle.customer_prices where customer_id::text like 'd0000000%';
-- update noodle.profiles set customer_id = null where customer_id::text like 'd0000000%';
-- delete from noodle.customers where id::text like 'd0000000%';
-- delete from noodle.recipe_lines where product_id::text like 'c0000000%';
-- delete from noodle.products where id::text like 'c0000000%';
-- delete from noodle.materials where id::text like 'b0000000%';
-- delete from noodle.suppliers where id::text like 'a0000000%';
-- ---------------------------------------------------------------------
