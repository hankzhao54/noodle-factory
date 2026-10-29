# 面坊 · Noodle Factory

面条工厂后台 + 客户订货门户。Vite + React + Supabase（与 order-app / 配方 app 共用同一个 Supabase，表都在独立的 `noodle` schema 里，不动现有数据）。

界面：Magyar（默认）/ English / 中文

网址：**https://noodle.101bistro.hu**（Vercel，DNS 在 MagyarHosting 用 CNAME 指向 Vercel；旧地址 noodle-factory-gamma.vercel.app 仍可用）。Supabase → Authentication → Redirect URLs 需包含 `https://noodle.101bistro.hu/**`。

## 功能

| 模块 | 做什么 |
|---|---|
| 今日 | 待确认订单、待开通账号、原料不足、今天送货、明天订单、待生产批次、在途进货 |
| 订单 | 看全部订单，确认 → 备好 → 送达；可代客户下单 |
| 生产 | 按交货日汇总订单需求 − 现有库存 − 已排生产 = 需生产，自动建议批数；检查原料够不够；完成生产自动扣原料、加成品、生成批号 |
| 送货 | 新建送货：选客户自动带出地址、电话、联系人、送货备注，选货品时能看到库存；按送货趟（司机/车辆）分组，装车清单；确认送达时可改实送数量、填签收人、拍照上传签收凭证（只给内部看，可下载）；按实送数量自动扣成品库存；打印单张或整趟送货单 |
| 库存 | 原料/成品现有量、最低库存提醒、盘点、报损、完整出入库记录 |
| 进货 | 进货单（草稿 → 已下单 → 收货入库），低于最低库存的原料一键生成进货单；收货时填批号和保质期，并更新原料成本 |
| 标签打印 | 默认「简洁」样式，同 OkoHACCP 的内容：品名、Azon（批号，多张时加 -01/-02）、Rögzítő（记录人）、Gyártás időp.、Fogyasztható（到分钟）、Mennyiség（每张数量）；二维码可选（默认不印）。默认 62 mm 连续纸 (DK-22205)、长 32 mm，文字自动放大到刚好占满。**手机**：点打印 → 分享菜单里选「打印」→ Brother QL-810W，用 iPhone 自带打印打 300 dpi 图片（iPhone 两端各留约 4.5 mm 白边，已按此加长标签）。**电脑**：打开精确尺寸的 PDF 打印（待电脑装好驱动后再调）。另有「完整」样式：配料表（过敏原加粗，包装不印）、生产商、储存条件等 |
| 标签设置 | 「Címke beállítások」页：每个产品的保质期（天）和每张标签默认数量（kg），以及没填时用的默认值；打印时自动带出，数量默认按 kg |
| 批次追溯 | 扫标签二维码打开 `/trace/批号`：生产时间、产量、保质期、所用原料及生产前最近一次进货批号 |
| 产品与配方 | 产品三语名称、图片、规格、保质期、标准价（产品图片也显示在客户下单页）；每批用料配方，自动算每批成本、单位成本、毛利率 |
| 原料 / 供应商 | 基础资料，原料带过敏原，可上传图片（手机可直接拍照，自动压缩到 1200 px）；名称三语，常用分类（面粉、淀粉、辅料、蛋、包装…）按界面语言显示，也可自己写新分类 |
| 客户 | 自家餐厅 / 外部批发；每个客户可设专属价格（管理员）；可关联拉面馆名单 `sales.ramen_leads` 的 place_id |
| 账号 | 管理员开通账号、设角色、把客户账号对应到客户 |

**客户门户**（手机优先）：客户登录后只能看到可订产品和自己的价格，下单、看历史订单、新订单可自行取消、一键再来一单。不含付款（货到后开发票）。

## 权限

- `admin` 全部，包括账号和客户价格
- `staff` 工厂日常工作
- `restaurant`（内部餐厅）只能给自己那家餐厅下单；看不到价格，不受最小起订量限制，下单直接算已确认
- `customer`（外部客户）只看自己的客户资料、价格和订单；价格由服务器决定，客户无法改价或替别人下单
- `pending` 刚注册，什么都看不到，等管理员开通

所有扣库存的操作（收货、完成生产、送达）都在数据库函数里一次完成，不会出现只扣一半的情况。

## 部署步骤

1. **建表**：Supabase → SQL Editor，运行 `supabase/001_noodle_schema.sql`
2. **开放 schema**：Settings → API → Exposed schemas，加上 `noodle`（和之前的 `ordering` 一样）
3. 依次运行 `supabase/003_restaurant_role.sql`、`005_default_hungarian.sql`、`006_delivery_proof.sql`、`007_delivery_proof_storage.sql`、`008_settings.sql`、`009_material_on_label.sql`、`010_label_defaults.sql`、`011_images.sql`
4. （可选）运行 `supabase/002_demo_data.sql` 装演示数据，文件底部有一键删除的 SQL
5. **本地运行**：
   ```
   copy .env.example .env      （填入 anon key，和 order-app 用的一样）
   npm install
   npm run dev
   ```
6. **第一个管理员**：在系统里注册并提交申请，然后在 SQL Editor 运行：
   ```sql
   update noodle.profiles set role = 'admin'
   where user_id = (select id from auth.users where email = '你的邮箱');
   ```
7. **上线**：推到 GitHub，Vercel 导入，环境变量填 `VITE_SUPABASE_URL` 和 `VITE_SUPABASE_ANON_KEY`（`vercel.json` 已配好路由）

> 注册要不要邮箱确认，取决于 Supabase → Authentication 的设置，和 order-app 共用同一设置。

## 开通内部餐厅账号

1. 在「客户」里建好餐厅，类型选「自家餐厅」
2. 餐厅员工注册并提交申请
3. 在「账号」里把角色设为「内部餐厅」，选对应的餐厅

## 开通外部客户

1. 在「客户」里建好客户（自家餐厅或外部批发），需要的话设专属价格
2. 让对方打开网址注册，填姓名、公司、电话提交
3. 在「账号」里把他设为「外部客户」，并选对应的客户

## 目前没做（可以后加）

- 人工排班（目前用 Homebase）
- 付款 / 开发票
- 原料按批号先进先出、过期提醒
- 送货路线排序
