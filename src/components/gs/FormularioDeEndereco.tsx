/**
 * O formulário do endereço da conta — criar e EDITAR (GAP-PRD-115).
 *
 * Um só, usado em "Minha conta" e no checkout da vitrine: dois formulários
 * divergiriam no primeiro ajuste, e o endereço é o mesmo nos dois lugares.
 *
 * O que ele pede além de rua e número:
 *   - QUEM RECEBE (opcional): a portaria, a mãe — vai na etiqueta;
 *   - PARA QUE SERVE: entrega, nota fiscal ou os dois;
 *   - o CÓDIGO IBGE do município, que a nota fiscal exige — e, desde a
 *     reauditoria do GAP-PRD-028, também a entrega: o endereço sem ele fica
 *     salvo, mas o checkout recusa entregar nele (422
 *     CHECKOUT_ENDERECO_INCOMPLETO) e o servidor recusa "nota fiscal" sem o
 *     código, com a frase que esta tela mostra.
 *
 * NÃO É UM <form>: no checkout ele mora DENTRO do formulário do pedido, e
 * formulário dentro de formulário não existe em HTML. Pelo mesmo motivo os
 * campos não levam `required` — a validação do navegador travaria o
 * "Finalizar pedido" por um endereço que a pessoa desistiu de cadastrar. Quem
 * confere é o servidor, e a recusa dele aparece aqui.
 *
 * A CIDADE PELO NOME (IBGE-MUNICIPIOS): com a tabela oficial de municípios
 * carregada no servidor, UF e cidade viram um seletor, e o código IBGE vem
 * junto com a cidade escolhida — o cliente nunca digita o código. Sem a
 * tabela (ou com o servidor fora), o campo digitado de antes continua, com o
 * texto de ajuda.
 */
import { useState } from 'react';
import { CidadeComSugestoes } from '@/components/gs/CidadeComSugestoes';
import { useTabelaDeMunicipios } from '@/hooks/useTabelaDeMunicipios';
import { UFS } from '@/lib/api/municipios';
import {
  ENDERECO_VAZIO,
  ROTULO_DO_TIPO,
  type DadosDoEndereco,
  type TipoDeEndereco,
} from '@/lib/api/enderecos';

const CAMPO = 'px-3 py-2 rounded-[var(--gs-radius)] border border-[var(--gs-border-strong)]';

export function FormularioDeEndereco({
  inicial = ENDERECO_VAZIO,
  titulo,
  rotuloSalvar = 'Salvar endereço',
  onSalvar,
  onCancelar,
}: {
  inicial?: DadosDoEndereco;
  titulo?: string;
  rotuloSalvar?: string;
  /** Lança (com a mensagem do servidor) quando não salvou. */
  onSalvar: (dados: DadosDoEndereco) => Promise<void>;
  onCancelar?: () => void;
}) {
  const [form, setForm] = useState<DadosDoEndereco>(inicial);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const tabela = useTabelaDeMunicipios();
  const comTabela = tabela === 'carregada';
  const ufDoForm = form.state.trim().toUpperCase();

  const campo = (
    rotulo: string,
    chave: Exclude<keyof DadosDoEndereco, 'kind'>,
    extra: Record<string, unknown> = {},
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-[length:var(--gs-text-sm)] font-semibold">{rotulo}</span>
      <input
        aria-label={rotulo}
        value={form[chave]}
        onChange={(ev) => setForm((f) => ({ ...f, [chave]: ev.target.value }))}
        className={CAMPO}
        {...extra}
      />
    </label>
  );

  const salvar = async () => {
    setOcupado(true);
    setErro(null);
    try {
      await onSalvar(form);
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não foi possível salvar o endereço.');
    } finally {
      setOcupado(false);
    }
  };

  // Sem IBGE, "nota fiscal" não passa no servidor: a tela avisa antes.
  const semIbgeParaNota = !form.cityIbge.trim() && (form.kind === 'ambos' || form.kind === 'faturamento');

  return (
    <div
      role="group"
      aria-label={titulo ?? 'Endereço'}
      /*
        Enter num campo daqui SALVA O ENDEREÇO — sem isto, dentro do checkout,
        o Enter submeteria o formulário do pedido e fecharia a compra.
      */
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
          e.preventDefault();
          void salvar();
        }
      }}
      className="bg-[var(--gs-surface)] border border-[var(--gs-border)] rounded-[var(--gs-radius)] p-4
        grid gap-3 sm:grid-cols-2"
    >
      {titulo && <strong className="sm:col-span-2">{titulo}</strong>}
      {campo('Apelido', 'label', { placeholder: 'Casa, trabalho…' })}
      {campo('Quem recebe', 'recipientName', {
        placeholder: 'Opcional — vazio, vai o seu nome',
        maxLength: 120,
      })}
      {campo('CEP', 'zip', { inputMode: 'numeric', 'aria-required': true })}
      {campo('Rua', 'street', { 'aria-required': true })}
      {campo('Número', 'number')}
      {campo('Complemento', 'complement')}
      {campo('Bairro', 'district')}
      {comTabela ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">UF</span>
            <select
              aria-label="UF"
              aria-required
              value={ufDoForm}
              // Trocou a UF: o código escolhido era de uma cidade da outra.
              onChange={(e) => setForm((f) => ({ ...f, state: e.target.value, cityIbge: '' }))}
              className={CAMPO}
            >
              <option value="">Escolha a UF</option>
              {UFS.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
              {ufDoForm && !UFS.includes(ufDoForm) && <option value={ufDoForm}>{ufDoForm} (corrija)</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[length:var(--gs-text-sm)] font-semibold">Cidade</span>
            <CidadeComSugestoes
              aria-label="Cidade"
              uf={ufDoForm}
              valor={form.city}
              // Mexeu no nome: o código era da cidade escolhida antes.
              onDigitar={(nome) => setForm((f) => ({ ...f, city: nome, cityIbge: '' }))}
              onEscolher={(m) => setForm((f) => ({ ...f, city: m.nome, state: m.uf, cityIbge: m.codigo }))}
              className={CAMPO}
            />
          </label>
          <p aria-live="polite" className="sm:col-span-2 m-0 text-[length:var(--gs-text-sm)]">
            {form.cityIbge ? (
              <>
                Código IBGE do município: <strong>{form.cityIbge}</strong> (veio com a cidade escolhida).
              </>
            ) : (
              <span className="text-[var(--gs-muted)]">
                Escolha a cidade na lista: o código IBGE do município vem junto.
              </span>
            )}
          </p>
        </>
      ) : (
        <>
          {campo('Cidade', 'city', { 'aria-required': true })}
          {campo('UF', 'state', { maxLength: 2, 'aria-required': true })}
          {campo('Código IBGE do município', 'cityIbge', {
            inputMode: 'numeric',
            maxLength: 7,
            placeholder: '7 dígitos — necessário para entrega e nota fiscal',
          })}
        </>
      )}
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="text-[length:var(--gs-text-sm)] font-semibold">Usar este endereço para</span>
        <select
          aria-label="Usar este endereço para"
          value={form.kind}
          onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as TipoDeEndereco | '' }))}
          className={CAMPO}
        >
          <option value="">Decidir pelo código IBGE (com ele: entrega e nota; sem ele: só entrega)</option>
          {(Object.keys(ROTULO_DO_TIPO) as TipoDeEndereco[]).map((t) => (
            <option key={t} value={t}>
              {ROTULO_DO_TIPO[t]}
            </option>
          ))}
        </select>
        <span className="text-[length:var(--gs-text-xs)] text-[var(--gs-muted)]">
          {comTabela ? (
            <>
              A entrega e a nota fiscal identificam o município pelo código IBGE — ele vem junto quando
              você escolhe a cidade na lista. Sem ele o endereço fica salvo, mas não recebe pedido nem
              vai na nota.
            </>
          ) : (
            <>
              A entrega e a nota fiscal identificam o município pelo código IBGE (7 dígitos) — está no
              site do IBGE, buscando o nome da cidade. Sem ele o endereço fica salvo, mas não recebe
              pedido nem vai na nota: complete antes de finalizar a compra.
            </>
          )}
        </span>
        {semIbgeParaNota && (
          <span role="status" className="text-[length:var(--gs-text-xs)] text-[var(--gs-warning)]">
            {comTabela
              ? 'Para usar na nota fiscal, escolha a cidade na lista (o código IBGE vem junto).'
              : 'Para usar na nota fiscal, informe o código IBGE do município.'}
          </span>
        )}
      </label>

      {erro && (
        <p role="alert" className="sm:col-span-2 m-0 text-[var(--gs-danger)] text-[length:var(--gs-text-sm)]">
          {erro}
        </p>
      )}

      <div className="sm:col-span-2 flex gap-2">
        <button
          type="button"
          disabled={ocupado}
          onClick={() => void salvar()}
          className="bg-[var(--gs-purple-700)] text-white border-0 rounded-[var(--gs-radius)]
            px-4 py-2 cursor-pointer font-semibold disabled:opacity-50"
        >
          {ocupado ? 'Salvando…' : rotuloSalvar}
        </button>
        {onCancelar && (
          <button
            type="button"
            onClick={onCancelar}
            className="bg-transparent border border-[var(--gs-border-strong)]
              rounded-[var(--gs-radius)] px-4 py-2 cursor-pointer"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}
