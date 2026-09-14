/**
 * A CHAVE DO LOGIN — como duas grafias do mesmo login viram a mesma conta.
 *
 * Os logins padrão do grupo têm espaço, hífen e acento ("PREÇO JUSTO",
 * "ADMIN-PJ MOTORS", "OFICINA-PREÇO JUSTO"). O `COLLATE NOCASE` do SQLite só
 * ignora maiúsculas no ASCII: "preço justo" não achava "PREÇO JUSTO", porque
 * "ç" e "Ç" são letras diferentes para ele.
 *
 * A chave é a forma NFC, sem espaço por fora, com os espaços de dentro unidos
 * e em minúsculas pelo português. O ACENTO CONTA: "PRECO JUSTO" não é
 * "PREÇO JUSTO" — o dono pediu os nomes preservados, e acento é parte do nome.
 *
 * Mora fora de `IdentityService` porque a equipe (TeamService) também confere
 * login ocupado, e as duas já se importam: um terceiro módulo evita o ciclo.
 */
import { getConnection } from '../../db/sqlite.js';
import { ensureCoreSchema } from '../../db/schema.js';

/** O login como a pessoa digita, na forma comparável. */
export function chaveDoLogin(login: string): string {
  return login.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
}

/**
 * A conta do login — ou `null`. Primeiro pelo caminho de sempre (índice,
 * `COLLATE NOCASE`); só quando ele não acha, pela chave, conta a conta. Duas
 * contas com a mesma chave e nenhuma exata: nenhuma (ambíguo não entra).
 */
export function contaPeloLogin<T extends { login: string }>(login: string): T | null {
  ensureCoreSchema();
  const db = getConnection();
  const digitado = login.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!digitado) return null;
  const exata = db.prepare('SELECT * FROM core_users WHERE login = ? COLLATE NOCASE').get(digitado) as T | undefined;
  if (exata) return exata;
  const chave = chaveDoLogin(digitado);
  const iguais = (db.prepare('SELECT * FROM core_users').all() as unknown as T[]).filter(
    (u) => chaveDoLogin(u.login) === chave,
  );
  return iguais.length === 1 ? iguais[0]! : null;
}
