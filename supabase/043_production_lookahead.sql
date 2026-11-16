-- 043 · 生产计划看接下来 N 天的订单（默认 5 天），在「下单规则」页设置
insert into noodle.settings(key, value) values ('production_lookahead_days', '5') on conflict (key) do nothing;
