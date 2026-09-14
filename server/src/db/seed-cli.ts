/**
 * `seed-cli` É O BOOTSTRAP DE PRODUÇÃO — o mesmo de `bootstrap-cli`.
 *
 * Até aqui este comando criava as seis empresas e treze contas de
 * demonstração. O nome fica porque instalações e roteiros antigos rodam
 * `node server/dist/db/seed-cli.js`: com uma build nova, esse comando passa a
 * criar só o estrutural e o administrador inicial (DEVORA_BOOTSTRAP_ADMIN_PASSWORD).
 * As contas de demonstração têm comando próprio, só para a bancada:
 * `npm run db:seed:dev --prefix server`.
 */
import './bootstrap-cli.js';
