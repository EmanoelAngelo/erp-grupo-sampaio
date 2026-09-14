/**
 * Configurações › Política de gestão (GAP-PRD-165 e GAP-PRD-166).
 *
 * Duas decisões moravam no código, com justificativa e sem o dono:
 *
 *   QUEM VÊ DINHEIRO   o painel (faturamento, ticket, recebíveis) e a posição de
 *                      estoque com custo abriam para atendente e estoquista. O
 *                      padrão agora é SEGURO — só a gerência vê — e o dono abre
 *                      para a equipe aqui, se quiser.
 *   A RÉGUA DO ESTOQUE último custo do cadastro (a de sempre) ou custo médio das
 *                      entradas. Quem confirma é o CONTADOR: a tela guarda o nome
 *                      e a data, e mostra a pendência até lá.
 *
 * Ler é do escritório inteiro — o atendente que não vê o faturamento precisa
 * saber que é decisão, e não defeito. SALVAR é dos donos do grupo (a rota nega a
 * todo o resto, gerentes inclusos): a ficha pediu que fosse do dono.
 */
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/gs/AppShell';
import { Badge, Button, Card, Field, Input, PageHeader } from '@/components/gs/ui';
import { useHasProfile } from '@/hooks/useSession';
import { ApiRequestError } from '@/lib/api/client';
import { dataBR } from '@/lib/datas';
import {
  politicaGestaoApi,
  type PoliticaDeGestao,
  type ReguaDeValorizacao,
} from '@/lib/api/politicaGestao';

export default function PoliticaGestaoPage() {
  // `useHasProfile()` sem perfil = só os donos (admin_geral e gestor) — o
  // espelho exato de `requireProfile(req)` no PUT.
  const dono = useHasProfile();
  const [politica, setPolitica] = useState<PoliticaDeGestao | null>(null);
  const [painel, setPainel] = useState(false);
  const [custo, setCusto] = useState(false);
  const [regua, setRegua] = useState<ReguaDeValorizacao>('ultimo_custo');
  const [contador, setContador] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  function espelhar(p: PoliticaDeGestao) {
    setPolitica(p);
    setPainel(p.painelFinanceiroEquipe);
    setCusto(p.custoDoEstoqueEquipe);
    setRegua(p.reguaDeValorizacao);
    setContador(p.reguaConfirmadaPor ?? '');
  }

  useEffect(() => {
    politicaGestaoApi
      .ler()
      .then(espelhar)
      .catch((err) =>
        setErro(err instanceof ApiRequestError ? err.message : 'Falha ao ler a política de gestão.'),
      );
  }, []);

  async function salvar() {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      /*
        O NOME DO CONTADOR SÓ VIAJA SE FOI MEXIDO. Reenviar o nome antigo junto
        de uma régua nova "confirmaria" a régua nova com a confirmação da velha —
        exatamente o que o servidor existe para não deixar acontecer.
      */
      const contadorMudou = contador.trim() !== (politica?.reguaConfirmadaPor ?? '');
      const salva = await politicaGestaoApi.salvar({
        painelFinanceiroEquipe: painel,
        custoDoEstoqueEquipe: custo,
        reguaDeValorizacao: regua,
        ...(contadorMudou ? { reguaConfirmadaPor: contador.trim() } : {}),
      });
      espelhar(salva);
      setAviso('Política salva. Vale a partir da próxima vez que cada tela for aberta.');
    } catch (err) {
      setErro(err instanceof ApiRequestError ? err.message : 'Falha ao salvar a política.');
    } finally {
      setSalvando(false);
    }
  }

  const trocouRegua = politica !== null && regua !== politica.reguaDeValorizacao;

  return (
    <AppShell>
      <PageHeader
        breadcrumb={['Configurações', 'Política de gestão']}
        title="Política de gestão"
        subtitle="Quem vê os números de dinheiro, e como o valor do estoque é calculado"
      />

      {erro && <p role="alert" className="text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">{erro}</p>}
      {aviso && <p role="status" className="text-[var(--gs-success)] text-[length:var(--gs-text-sm)]">{aviso}</p>}

      {politica && !politica.decidida && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
          O dono ainda não decidiu: valem os padrões seguros abaixo (só a gerência vê dinheiro; o
          estoque é valorizado pelo custo do cadastro).
        </p>
      )}
      {!dono && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Só o dono do grupo altera esta política. Aqui você vê o que está valendo.
        </p>
      )}

      <Card
        title="Quem vê os números de dinheiro"
        subtitle="Gerentes da loja e da oficina sempre veem. Atendente e estoquista, só se o dono abrir."
        className="mb-5"
      >
        <label className="flex items-start gap-2 text-[length:var(--gs-text-base)] mb-3">
          <input
            type="checkbox"
            checked={painel}
            disabled={!dono}
            onChange={(e) => setPainel(e.target.checked)}
          />
          <span>
            Atendente e estoquista veem <strong>faturamento, ticket médio e contas a receber</strong>{' '}
            no painel
            <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Desligado, o painel deles mostra as vendas, os produtos que saíram e os alertas de
              estoque — sem os valores.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[length:var(--gs-text-base)]">
          <input
            type="checkbox"
            checked={custo}
            disabled={!dono}
            onChange={(e) => setCusto(e.target.checked)}
          />
          <span>
            Atendente e estoquista veem <strong>custo e valor na posição de estoque</strong>
            <span className="block text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
              Desligado, a posição deles mostra saldo, reservado e mínimo. O custo que o estoquista
              usa trabalhando — na entrada da nota, no pedido de compra — não muda.
            </span>
          </span>
        </label>
      </Card>

      <Card
        title="Como o valor do estoque é calculado"
        subtitle="A régua vale para a posição de estoque, o painel e os relatórios da Central."
        className="mb-5"
      >
        <div className="flex flex-col gap-2 mb-3">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="regua"
              checked={regua === 'ultimo_custo'}
              disabled={!dono}
              onChange={() => setRegua('ultimo_custo')}
            />
            <span>
              <strong>Último custo</strong> — saldo × custo do cadastro (o da compra mais recente)
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="regua"
              checked={regua === 'custo_medio'}
              disabled={!dono}
              onChange={() => setRegua('custo_medio')}
            />
            <span>
              <strong>Custo médio</strong> — a média ponderada das entradas registradas no histórico
              de estoque (produto sem entrada com custo usa o do cadastro, e a tela avisa)
            </span>
          </label>
        </div>

        {politica?.reguaConfirmadaPor && !trocouRegua ? (
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            <Badge tone="success">Confirmada pelo contador</Badge>{' '}
            {politica.reguaConfirmadaPor}
            {politica.reguaConfirmadaEm ? ` em ${dataBR(politica.reguaConfirmadaEm)}` : ''}
          </p>
        ) : (
          <p className="m-0 text-[length:var(--gs-text-sm)]">
            <Badge tone="warning">Aguardando o contador</Badge>{' '}
            A régua do inventário e do balanço é decisão contábil. Pergunte ao contador qual usar e
            registre o nome dele abaixo quando ele confirmar.
          </p>
        )}
        <div className="max-w-md mt-3">
          <Field label="Confirmada pelo contador" hint="Nome do contador ou do escritório — vazio desfaz a confirmação">
            {(p) => (
              <Input
                {...p}
                value={contador}
                disabled={!dono}
                onChange={(e) => setContador(e.target.value)}
                placeholder="Contabilidade Silva"
              />
            )}
          </Field>
          {trocouRegua && politica?.reguaConfirmadaPor && (
            <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-warning)]">
              Trocar a régua derruba a confirmação anterior — ela era da outra conta.
            </p>
          )}
        </div>
      </Card>

      {dono && (
        <Button loading={salvando} disabled={!politica} onClick={() => void salvar()}>
          Salvar política
        </Button>
      )}
      {politica?.updatedAt && (
        <p className="text-[length:var(--gs-text-sm)] text-[var(--gs-muted)]">
          Última alteração em {dataBR(politica.updatedAt)}.
        </p>
      )}
    </AppShell>
  );
}
