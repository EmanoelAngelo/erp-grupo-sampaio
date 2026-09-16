/**
 * ============================================================================
 * O DESTINATÁRIO DE UMA NF-e — um formulário só, em toda tela que emite
 * ============================================================================
 *
 * A NF-e (modelo 55) exige o destinatário com ENDEREÇO e o código IBGE do
 * município — é assim que a nota identifica a cidade, e não pelo nome. A NFC-e
 * do balcão não exige nada disso: sai com o CPF, ou sem ele.
 *
 * É por isso que este formulário existe e por que ele PERGUNTA em vez de o
 * sistema adivinhar: o endereço de quem compra no balcão a loja não tem
 * (`core_customers` guarda endereço como texto livre, sem município separado
 * nem IBGE). Inventar endereço seria pôr dado falso numa nota fiscal — e nota
 * com endereço errado é recusada pela SEFAZ depois de numerada, ou pior,
 * autorizada errada.
 *
 * O que o sistema JÁ SABE — nome e CPF/CNPJ que foram para a nota da venda —
 * vem preenchido por quem usa o formulário. O município é escolhido na lista
 * oficial (`CidadeComSugestoes`): ninguém digita os 7 dígitos do IBGE.
 *
 * Duas telas emitem NF-e a partir de uma venda: a ficha da devolução (a nota
 * de entrada, finalidade 4) e a ficha da venda (a nota da venda de balcão).
 * Um formulário só — duas cópias divergiriam no primeiro campo novo do
 * leiaute. As funções puras moram em `@/lib/destinatarioDaNota`.
 *
 * A CONDIÇÃO FISCAL (indIEDest) É PERGUNTADA, e era o campo sem escritor: o
 * corpo saía com '9' (não contribuinte) cravado no código e o formulário não
 * oferecia nada para corrigi-lo, então o cliente PJ CONTRIBUINTE — o caso de
 * uso que justifica a NF-e de balcão — recebia uma nota que declarava a
 * operação errada, sem caminho nenhum no sistema para emiti-la certa.
 */
import { Field, Input } from '@/components/gs/ui';
import { CidadeComSugestoes } from '@/components/gs/CidadeComSugestoes';
import { UFS } from '@/lib/api/municipios';
import {
  documentoDoDestinatarioConfere,
  type IndicadorDeIe,
  type RascunhoDoDestinatario,
} from '@/lib/destinatarioDaNota';

/** O que cada indicador significa no balcão — a frase, não o número. */
const CONDICOES: { valor: IndicadorDeIe; texto: string }[] = [
  { valor: '9', texto: 'Não contribuinte (consumidor)' },
  { valor: '1', texto: 'Contribuinte com inscrição estadual' },
  { valor: '2', texto: 'Contribuinte isento de inscrição' },
];

export function FormularioDoDestinatario({
  valor,
  onMudar,
}: {
  valor: RascunhoDoDestinatario;
  onMudar: (f: RascunhoDoDestinatario) => void;
}) {
  const set = (chave: keyof RascunhoDoDestinatario) => (texto: string) =>
    onMudar({ ...valor, [chave]: texto });

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Field label="Nome do cliente" required>
        {(p) => <Input {...p} value={valor.name} onChange={(e) => set('name')(e.target.value)} />}
      </Field>
      <Field
        label="CPF ou CNPJ"
        required
        error={
          valor.document && !documentoDoDestinatarioConfere(valor.document)
            ? 'CPF tem 11 dígitos; CNPJ, 14.'
            : undefined
        }
      >
        {(p) => <Input {...p} value={valor.document} onChange={(e) => set('document')(e.target.value)} />}
      </Field>
      <Field label="CEP">
        {(p) => <Input {...p} value={valor.zip} onChange={(e) => set('zip')(e.target.value)} />}
      </Field>

      {/*
        A CONDIÇÃO FISCAL DE QUEM RECEBE — o campo que não tinha escritor.

        O DEFEITO: o corpo saía sempre com `ieIndicator: '9'` (não
        contribuinte) e o formulário não perguntava nada, então TODA nota das
        telas novas ia com indIEDest 9 e indFinal 1 — inclusive para CNPJ. O
        cliente PJ contribuinte, que é o caso de uso da NF-e de balcão, não
        tinha caminho nenhum no sistema para receber a nota certa. Errar isto
        muda a tributação da operação.
      */}
      <Field
        label="Condição fiscal do destinatário"
        required
        hint="É o indicador de inscrição estadual da nota (indIEDest) — muda a tributação da operação."
      >
        {(p) => (
          <select
            {...p}
            value={valor.ieIndicator}
            onChange={(e) => {
              const ieIndicator = e.target.value as IndicadorDeIe;
              onMudar({
                ...valor,
                ieIndicator,
                // Deixar de ser contribuinte com IE apaga a inscrição: ela era
                // da condição anterior, e iria para a nota contradizendo-a.
                ie: ieIndicator === '1' ? valor.ie : '',
                /*
                  O padrão de cada condição é o que o servidor DEDUZIRIA sem a
                  declaração (`indicadorDeConsumidorFinal`): não contribuinte e
                  isento são consumidor final; contribuinte com inscrição
                  compra para revender. Trocar a condição e herdar a resposta
                  da anterior faria a tela declarar o que ninguém disse.
                */
                consumidorFinal: ieIndicator !== '1',
              });
            }}
            className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
              bg-[var(--gs-surface)] px-3 py-2"
          >
            {CONDICOES.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.texto}
              </option>
            ))}
          </select>
        )}
      </Field>
      {valor.ieIndicator === '1' && (
        <Field
          label="Inscrição estadual"
          required
          hint="Só dígitos (no RS, o CGC/TE)."
          error={
            valor.ie && !/\d/.test(valor.ie)
              ? '"ISENTO" não é inscrição: para isento, escolha "Contribuinte isento de inscrição".'
              : undefined
          }
        >
          {(p) => <Input {...p} value={valor.ie} onChange={(e) => set('ie')(e.target.value)} />}
        </Field>
      )}
      {valor.ieIndicator !== '9' && (
        <Field label="Destino da mercadoria" hint="Decide o indFinal da nota.">
          {(p) => (
            <select
              {...p}
              value={valor.consumidorFinal ? 'consumo' : 'revenda'}
              onChange={(e) => onMudar({ ...valor, consumidorFinal: e.target.value === 'consumo' })}
              className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
                bg-[var(--gs-surface)] px-3 py-2"
            >
              <option value="revenda">Revenda ou industrialização</option>
              <option value="consumo">Uso ou consumo do destinatário</option>
            </select>
          )}
        </Field>
      )}
      <Field label="Logradouro" required>
        {(p) => <Input {...p} value={valor.street} onChange={(e) => set('street')(e.target.value)} />}
      </Field>
      <Field label="Número" required>
        {(p) => <Input {...p} value={valor.number} onChange={(e) => set('number')(e.target.value)} />}
      </Field>
      <Field label="Complemento">
        {(p) => <Input {...p} value={valor.complement} onChange={(e) => set('complement')(e.target.value)} />}
      </Field>
      <Field label="Bairro" required>
        {(p) => <Input {...p} value={valor.district} onChange={(e) => set('district')(e.target.value)} />}
      </Field>
      <Field label="UF" required>
        {(p) => (
          <select
            {...p}
            value={valor.uf}
            // Trocar a UF apaga a cidade E o código: o par vinha da UF anterior.
            onChange={(e) => onMudar({ ...valor, uf: e.target.value, cityName: '', cityIbge: '' })}
            className="w-full rounded-[var(--gs-radius)] border border-[var(--gs-border)]
              bg-[var(--gs-surface)] px-3 py-2"
          >
            <option value="">—</option>
            {UFS.map((uf) => (
              <option key={uf} value={uf}>
                {uf}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Município" required hint="Escolha na lista: o código IBGE vem junto.">
        {(p) => (
          <CidadeComSugestoes
            {...p}
            uf={valor.uf}
            valor={valor.cityName}
            // Digitar apaga o código: ele era da cidade de antes.
            onDigitar={(nome) => onMudar({ ...valor, cityName: nome, cityIbge: '' })}
            onEscolher={(m) => onMudar({ ...valor, cityName: m.nome, cityIbge: m.codigo, uf: m.uf })}
          />
        )}
      </Field>
    </div>
  );
}
