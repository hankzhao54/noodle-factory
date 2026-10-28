# 面坊 测试账号

三个账号密码相同：`Mf-24SoT4DJy7`

| 邮箱 | 角色 | 对应客户 | 登录后看到 |
|---|---|---|---|
| restaurant@test.local | 内部餐厅 | TEST 测试餐厅 | 只能下单，没有价格，没有起订量，下单直接确认 |
| customer@test.local | 外部客户 | TEST Ramen Kft | 下单页，有价格和起订量，下单后等工厂确认 |
| staff@test.local | 员工 | – | 后台全部功能，但没有「账号」页、改不了客户价格 |

同时测几个账号时，用不同浏览器或无痕窗口，就不会互相挤掉登录。

## 测试完删除

在 Supabase SQL Editor 运行：

```sql
delete from noodle.orders where customer_id::text like 'f0000000%';
delete from noodle.profiles where user_id in (select id from auth.users where email like '%@test.local');
delete from noodle.customer_prices where customer_id::text like 'f0000000%';
delete from noodle.customers where id::text like 'f0000000%';
delete from auth.users where email like '%@test.local';
```
