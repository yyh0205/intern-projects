# 云端同步设置（给 Maggie）

> 注意：当前网页已预留云同步接口，但正式上线前建议加上 Supabase Auth 登录。下面的匿名策略只适合先做演示，不建议直接存放真实候选人信息。

1. 注册 Supabase，创建一个新项目。
2. 在 SQL Editor 执行：

```sql
create table if not exists public.workspaces (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.workspaces enable row level security;
create policy "workspace read" on public.workspaces for select using (true);
create policy "workspace write" on public.workspaces for insert with check (true);
create policy "workspace update" on public.workspaces for update using (true);
```

3. 在 Project Settings → API 复制 Project URL 和 `anon public` key。
4. 打开同目录的 `supabase-config.js`，填入：

```js
window.SUPABASE_CONFIG = {
  url: '你的 Project URL',
  anonKey: '你的 anon public key',
  workspaceId: 'maggie-hrbp-workbench'
};
```

5. 将整个 `hrbp-workbench` 文件夹部署到 Vercel。部署后，电脑和手机打开同一个 Vercel 链接即可同步。

> 这是个人工作台方案。若未来需要多人账号和权限，再升级为 Supabase Auth + RLS。
