# 🌊 PMS Mar de Moreré

Painel operacional da pousada — gestão e visualização de reservas.
Arquivo único (`index.html`), sem build, sem dependência. Dados em `localStorage`.

**Live:** https://pms-morere.vercel.app

## Uso

Abrir `index.html` no navegador (ou a URL acima).
Desktop = timeline por quarto · celular = visão "Hoje".

- 🗓 Timeline: eixo X datas, eixo Y Q2–Q9 + "a definir"
- 🖱 Arrastar bloco = trocar de quarto · clique em dia vazio = criar reserva
- 🔴 Conflito de quarto = contorno vermelho + alerta
- ↩ Desfazer com Ctrl+Z
- 💾 Exportar/importar JSON · dados salvos no navegador

## Integrações futuras (§11)

`window.PMS.adapters.booking/airbnb/whatsapp` — `importar(arr)` aceita
`[{guest,ci,co,room,channel,total,paid,phone,pax,obs}]`.

## Deploy

```bash
vercel deploy --prod --yes --name pms-morere --scope diogothugs-projects
```
