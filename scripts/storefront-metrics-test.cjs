const assert = require('node:assert/strict')
const { parseCriticScoreHtml, summarizeSteamSalesRows } = require('../packages/core/dist/index.cjs')

const critic = parseCriticScoreHtml(
  '<script type="application/ld+json">{"aggregateRating":{"@type":"AggregateRating","ratingValue":87,"reviewCount":42}}</script>',
  'metacritic',
  'https://www.metacritic.com/game/example/',
)
assert.deepEqual(critic, {
  provider: 'metacritic',
  score: 87,
  reviewCount: 42,
  url: 'https://www.metacritic.com/game/example/',
})

const sales = summarizeSteamSalesRows(
  [
    {
      line_item_type: 'Package',
      package_sale_type: 'Steam',
      primary_appid: 10,
      net_units_sold: 8,
      net_sales_usd: '80.50',
    },
    {
      line_item_type: 'Package',
      package_sale_type: 'Steam',
      primary_appid: 10,
      net_units_sold: -1,
      net_sales_usd: '-10.00',
    },
    { line_item_type: 'Package', package_sale_type: 'Retail', primary_appid: 10, net_units_sold: 100 },
    { line_item_type: 'MicroTxn', primary_appid: 10, net_units_sold: 50 },
    { line_item_type: 'Package', package_sale_type: 'Steam', primary_appid: 99, net_units_sold: 20 },
  ],
  [10],
)
assert.deepEqual(sales, { 10: { netUnits: 7, netSalesUsd: 70.5 } })

console.log('STOREFRONT METRICS OK')
