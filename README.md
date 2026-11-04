# SAHA Tour Hub

Hệ thống nội bộ quản lý booking và điều hành tour đa kênh (Viator, GetYourGuide, nhập file, tạo tay). Cấu trúc theo monorepo `keodansaha`.

**Trạng thái:** chưa kết nối thật với Viator hay GetYourGuide (chỉ có connector mô phỏng), chưa deploy, chưa chạy trên Supabase thật. Xem [docs/STATUS.md](docs/STATUS.md).

## Cấu trúc

```text
tours_manager/
├── apps/admin/            React + Vite + Ant Design + TanStack Query, Cloudflare Worker tĩnh
├── packages/
│   ├── tour-core/         Tiền, CSV, chuẩn hóa dòng nhập, nhãn tiếng Việt. Không phụ thuộc framework
│   ├── channels/          Giao diện connector, hai connector mô phỏng, bộ sinh sự kiện
│   └── database/          Bộ test trên Postgres thật
├── services/tour-worker/  Worker Node: outbox, hết hạn giữ chỗ, retry, dọn payload, /health
├── supabase/migrations/   Nguồn sự thật của lược đồ, RLS, RPC
├── scripts/               Seed demo, tạo tài khoản, stack dev không cần Docker
└── docs/                  Kiến trúc, API, nhập dữ liệu, kết nối kênh, vận hành, trạng thái
```

## Chạy local

Cần Node 22 trở lên và pnpm.

```bash
pnpm install
```

### Cách 1: Supabase CLI (cần Docker)

```bash
pnpm db:start
```

Lệnh trên in ra các khóa. Sao chép `.env.example` thành `.env`, `apps/admin/.env.example` thành `apps/admin/.env.local`, rồi điền khóa.

### Cách 2: không cần Docker

Chép bản Windows của [PostgREST](https://github.com/PostgREST/postgrest/releases) vào `.tools/postgrest/postgrest.exe`, rồi:

```bash
pnpm dev:stack
```

Lệnh này chạy Postgres, PostgREST và một cổng giả lập API Supabase tại `http://127.0.0.1:55421`, đồng thời tự ghi `.env` và `apps/admin/.env.local`. Chỉ dùng cho dev: cổng xác thực này không được đưa lên production.

### Dữ liệu demo, app và worker

```bash
pnpm db:seed
```

```bash
pnpm dev:admin
```

```bash
pnpm dev:worker
```

App chạy ở `http://localhost:3101`. Tài khoản demo nằm trong `.env.demo-accounts` (không vào Git). Seed từ chối chạy nếu database không phải local.

## Kiểm thử

Bộ test tự tạo một database tạm trên Postgres thật, áp migration rồi xóa. Có Docker thì dùng `pnpm db:start`. Không có thì mở một terminal chạy:

```bash
pnpm db:test-server
```

Rồi ở terminal khác:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55423/postgres pnpm test:db
```

## Tài liệu

- [Trạng thái, giới hạn, việc tiếp theo](docs/STATUS.md)
- [Kiến trúc và sơ đồ quan hệ](docs/ARCHITECTURE.md)
- [API nội bộ](docs/API.md)
- [Nhập dữ liệu và ghép mã](docs/IMPORT_AND_MAPPING.md)
- [Kết nối Viator và GetYourGuide](docs/CHANNEL_INTEGRATION.md)
- [Vận hành: sao lưu, bí mật, dữ liệu cá nhân](docs/OPERATIONS.md)
- [Quyết định kiến trúc](docs/DECISION_LOG.md)
