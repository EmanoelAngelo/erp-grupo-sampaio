/**
 * O QUE FALTA PARA OS E-MAILS DESTA EMPRESA SAÍREM (GAP-PRD-130).
 *
 * Tudo já está programado — o e-mail ao cliente, o pacote mensal do contador,
 * a NF-e por e-mail. O que faltava era UM lugar que dissesse, por empresa, o
 * que ainda é configuração: a senha SMTP no .env, o endereço do escritório de
 * contabilidade, a agenda do dia 1, o usuário do contador, a senha de
 * aplicativo da caixa de notas. Antes, isso só aparecia abrindo três telas e o
 * banco.
 *
 * A lista vem do SERVIDOR (`GET /core/comunicacoes/prontidao`), da empresa do
 * token. Cada item diz o que se vê, o que fazer, quem fornece e onde.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiRequestError } from '@/lib/api/client';
import {
  comunicacoesApi,
  type ItemDaProntidao,
  type ProntidaoDasComunicacoes as Prontidao,
} from '@/lib/api/comunicacoes';

const SELO: Record<ItemDaProntidao['situacao'], { rotulo: string; classe: string }> = {
  ok: { rotulo: 'Pronto', classe: 'bg-[var(--gs-success-bg)] text-[var(--gs-success)]' },
  falta: { rotulo: 'Falta', classe: 'bg-[var(--gs-warning-bg)] text-[var(--gs-warning)]' },
  opcional: { rotulo: 'Opcional', classe: 'bg-[var(--gs-surface-hover)] text-[var(--gs-text-soft)]' },
};

const QUEM: Record<NonNullable<ItemDaProntidao['quem']>, string> = {
  dono: 'o dono',
  gerente: 'o gerente',
  contador: 'o escritório de contabilidade',
};

export function ProntidaoDasComunicacoes() {
  const [dados, setDados] = useState<Prontidao | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    comunicacoesApi
      .prontidao()
      .then(setDados)
      .catch((err: unknown) => {
        setErro(
          err instanceof ApiRequestError
            ? err.message
            : 'Não foi possível conferir o que falta para os e-mails saírem.',
        );
      });
  }, []);

  return (
    <section
      aria-label="O que falta para os e-mails desta empresa saírem"
      className="bg-[var(--gs-surface)] border border-[var(--gs-border)]
        rounded-[var(--gs-radius-lg)] p-5 mb-6"
    >
      <strong className="text-[length:var(--gs-text-lg)]">
        O que falta para os e-mails desta empresa saírem
      </strong>
      <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)] mt-1 mb-3">
        E-mail ao cliente, pacote do contador e NF-e por e-mail já estão programados. O que
        aparece como &quot;Falta&quot; é configuração — nenhuma depende de programação.
      </p>

      {erro && (
        <p role="alert" className="text-[var(--gs-danger)] m-0">
          {erro}
        </p>
      )}

      {dados && (
        <>
          <p className="m-0 mb-3 font-semibold">
            {dados.pronto
              ? 'Tudo pronto: as comunicações desta empresa estão configuradas.'
              : `${dados.faltam} item(ns) por configurar.`}
          </p>
          <ul className="list-none m-0 p-0">
            {dados.itens.map((item) => (
              <li
                key={item.chave}
                className="py-3 border-b border-[var(--gs-border)] last:border-0 text-[length:var(--gs-text-sm)]"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`px-2 py-0.5 rounded-[var(--gs-radius)] text-[length:var(--gs-text-xs)] font-semibold ${SELO[item.situacao].classe}`}
                  >
                    {SELO[item.situacao].rotulo}
                  </span>
                  <strong>{item.rotulo}</strong>
                </div>
                <p className="m-0 mt-1">{item.detalhe}</p>
                {item.oQueFazer && (
                  <p className="m-0 mt-1 text-[var(--gs-muted)]">
                    <span className="font-semibold">O que fazer: </span>
                    {item.oQueFazer}
                    {item.quem && <> (quem fornece: {QUEM[item.quem]})</>}
                    {item.onde && (
                      <>
                        {' — '}
                        {item.onde.caminho ? (
                          <Link to={item.onde.caminho} className="text-[var(--gs-purple-700)]">
                            {item.onde.rotulo}
                          </Link>
                        ) : (
                          <span className="font-mono">{item.onde.rotulo}</span>
                        )}
                      </>
                    )}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
