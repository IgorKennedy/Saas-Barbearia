# Barbify — gestão multi-barbearia (SaaS)

Next.js 16 (App Router) · TypeScript · Supabase (Auth + Postgres + RLS + Storage) · Tailwind 4 · deploy na Vercel.

## Colocar no ar (GitHub → Supabase → Vercel)

### 1. GitHub
Crie um repositório vazio, envie o conteúdo desta pasta (a raiz do repositório deve conter `package.json`, `src/`, `supabase/`).

### 2. Supabase (banco)
1. Crie um projeto em supabase.com e anote a senha do banco.
2. Abra **SQL Editor → New query**, cole **todo** o conteúdo de `supabase/schema_completo.sql` e execute **uma vez**. (É a junção das 4 migrations em `supabase/migrations/`. Se preferir a CLI: `supabase link` + `supabase db push`.)
3. **Project Settings → API**: copie `Project URL` e a chave `anon public`.
4. **Authentication → URL Configuration**: em *Site URL* coloque a URL da Vercel (passo 3) e adicione-a também em *Redirect URLs*. Sem isso, o link de confirmação de e-mail aponta para o endereço errado.
5. (Opcional, para testar rápido) **Authentication → Providers → Email**: desative *Confirm email*. Em produção, mantenha ativado.

### 3. Vercel
1. **Add New → Project**, importe o repositório do GitHub (Framework: Next.js, detectado sozinho).
2. Em **Environment Variables**, cadastre:

| Variável | Valor |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL do Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chave `anon public` |

3. Deploy. Se você cadastrar as variáveis **depois** do primeiro deploy, faça **Redeploy** (variáveis `NEXT_PUBLIC_` são embutidas no build).
4. Sem as variáveis o site abre, mas `/app` e `/master` redirecionam para `/setup`.

> **Nunca** coloque a chave `service_role` em variável `NEXT_PUBLIC_*`. O app atual não precisa dela.

### 4. Virar administrador Master
1. Abra o site, clique em **Criar conta** e cadastre-se (confirme o e-mail se exigido).
2. No SQL Editor do Supabase, execute (trocando o e-mail):
```sql
insert into public.platform_admins (user_id, granted_by)
select id, 'bootstrap' from auth.users where email = 'voce@dominio.com';
```
3. Acesse `/master`. Um usuário comum jamais consegue se promover: a tabela `platform_admins` não aceita escrita pela aplicação.

## Rodar localmente
```bash
npm install
cp .env.example .env.local   # preencha URL e anon key
npm run dev                  # http://localhost:3000
```

## Estrutura
- `src/app/page.tsx` — página inicial (index) · `login`, `app`, `master/*`, `setup`
- `src/proxy.ts` — renova a sessão e redireciona anônimos (a autorização real está no banco e nas Server Actions)
- `src/lib/domain/pricing.ts` — calculadora de precificação (fórmulas documentadas no arquivo)
- `supabase/migrations/` — schema versionado · `supabase/schema_completo.sql` — mesmo conteúdo em um arquivo
- `tests/` — 64 testes (`npm test`). Os de banco exigem PostgreSQL local (usuário/senha `postgres`) e recriam o banco `barber_test`; o CI do GitHub já sobe um Postgres.

## O que está pronto (banco + regras, testado)
Organizações isoladas por RLS · painel Master (barbearias, planos, módulos por barbearia com 3 camadas, teste grátis, suspensão, auditoria) · barbeiros · agenda sem conflito (inclusive reservas simultâneas) · retorno automático de clientes e remarketing com consentimento · comissões com precedência e snapshot · prateleira, estoque e vendas · financeiro · assinaturas de clientes · relatório mensal · calculadora de preço · fotos de serviços (bucket `shop-media`).

## O que ainda falta (seja realista antes de vender)
- **Telas da barbearia** para agenda, clientes, serviços (upload de fotos), barbeiros/comissões, prateleira/estoque, financeiro, relatórios, assinaturas e calculadora. O banco e as regras existem e estão testados; a interface ainda não.
- Página pública de agendamento, upsell, automações/envio de mensagens, cobrança recorrente real do SaaS (provedor + webhook), horário de funcionamento na reserva, convite de funcionários por e-mail, documentação de LGPD/backup.
- Nada foi testado contra um projeto Supabase hospedado; os testes usam um stub mínimo do Auth. Faça um teste de ponta a ponta após o primeiro deploy.

## Regra de permissões ao criar novas tabelas
O Supabase concede `ALL` a toda tabela nova. Toda migration que cria tabelas deve terminar revogando de `anon, authenticated` e re-concedendo só o necessário (veja o fim de `0004_operations.sql`). Os testes já pegaram um vazamento desse tipo.
