-- 测试账号：先在 Supabase → Authentication → Users → Add user 建好这三个邮箱
-- （勾选 Auto Confirm User），然后运行本文件。可以重复运行。

insert into noodle.customers (id, name, type, address, delivery_notes)
values ('f0000000-0000-0000-0000-000000000001', 'TEST 测试餐厅', 'internal', 'Budapest', '测试用'),
       ('f0000000-0000-0000-0000-000000000002', 'TEST Ramen Kft', 'wholesale', 'Budapest', '测试用')
on conflict (id) do nothing;

insert into noodle.profiles (user_id, role, customer_id, display_name, company)
select u.id, v.role, v.cust::uuid, v.name, v.company
from (values
  ('restaurant@test.local', 'restaurant', 'f0000000-0000-0000-0000-000000000001', '测试 · 内部餐厅', 'TEST 测试餐厅'),
  ('customer@test.local',   'customer',   'f0000000-0000-0000-0000-000000000002', '测试 · 外部客户', 'TEST Ramen Kft'),
  ('staff@test.local',      'staff',      null,                                   '测试 · 员工',     '面坊')
) as v(email, role, cust, name, company)
join auth.users u on lower(u.email) = v.email
on conflict (user_id) do update
  set role = excluded.role, customer_id = excluded.customer_id, display_name = excluded.display_name;

-- 检查结果：应该看到三行
select u.email, p.role, c.name as customer
from noodle.profiles p
join auth.users u on u.id = p.user_id
left join noodle.customers c on c.id = p.customer_id
where u.email like '%@test.local';

-- 测试完删除：
-- delete from noodle.profiles where user_id in (select id from auth.users where email like '%@test.local');
-- delete from noodle.orders where customer_id::text like 'f0000000%';
-- delete from noodle.customers where id::text like 'f0000000%';
-- 然后在 Authentication → Users 里删掉这三个用户
