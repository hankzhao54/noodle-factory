-- 040 · 后台无操作自动退出（分钟，0 = 不退出），在「下单规则」页设置
insert into noodle.settings(key, value) values ('idle_logout_minutes', '30') on conflict (key) do nothing;
