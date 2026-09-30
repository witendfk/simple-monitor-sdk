import './integrate'
import './app.css'

/**
 * 订单管理台业务逻辑 —— 注意：本文件除顶部引入接入入口外，不含任何 SDK API。
 * 监控数据的产生全部来自真实业务操作（下单 / 支付 / 路由切换 / 页面渲染）。
 */

interface Order {
  id: string
  no: string
  item: string
  amount: number | string // 故障注入时可能为字符串（脏数据）
  status: 'pending' | 'paid' | 'cancelled'
  createdAt: string
}

let orders: Order[] = []
let faultOn = false
let keyword = ''
/** 本会话支付尝试 / 失败计数（统计卡「支付失败率」数据源） */
let payTries = 0
let payFails = 0

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector(sel)
  if (!el) throw new Error(`missing element: ${sel}`)
  return el as T
}

function money(n: number): string {
  // 金额格式化依赖数值方法（toFixed）——故障注入的字符串脏数据会在此抛
  // TypeError: n.toFixed is not a function（真实应用脏数据 bug 的形态，交由 SDK 采集）
  return `¥${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

function badge(status: Order['status']): string {
  const map = {
    paid: ['已支付', 'b-paid'],
    pending: ['待支付', 'b-pending'],
    cancelled: ['已取消', 'b-cancel'],
  } as const
  const [text, cls] = map[status]
  return `<span class="badge ${cls}">${text}</span>`
}

function renderStats(): void {
  const paid = orders.filter((o) => o.status === 'paid')
  const revenue = paid.reduce((sum, o) => sum + (o.amount as number), 0)
  const pending = orders.filter((o) => o.status === 'pending').length
  const failRate = payTries > 0 ? ((payFails / payTries) * 100).toFixed(1) : '0.0'
  $('#stat-orders').textContent = String(orders.length)
  $('#stat-revenue').textContent = money(revenue)
  $('#stat-pending').textContent = String(pending)
  $('#stat-fail').textContent = `${failRate}%`
  $('#stat-fail').classList.toggle('bad', payFails > 0)
  const failDesc = $('#stat-fail-desc')
  failDesc.textContent = payFails > 0 ? `↑ ${payFails}/${payTries} 次（注入中）` : '本会话尝试'
  failDesc.classList.toggle('bad', payFails > 0)
}

function renderTable(): void {
  const body = $('#order-rows')
  const list = orders.filter((o) => !keyword || o.no.includes(keyword) || o.item.includes(keyword))
  // 注意：脏数据行在这里抛 TypeError（amount 非数值）—— 故障注入下表格中断、
  // 后续行不渲染。这是「真实应用 bug」，由 SDK 采集，不在此处捕获。
  body.innerHTML = list
    .map(
      (o) => `
      <tr data-id="${o.id}">
        <td class="mono">${o.no}</td>
        <td>${o.item}</td>
        <td class="num"><b>${money(o.amount as number)}</b></td>
        <td>${badge(o.status)}</td>
        <td>${actions(o)}</td>
      </tr>`
    )
    .join('')
  bindRowActions()
}

function actions(o: Order): string {
  const detail = `<a class="link" href="#/order/${o.id}">详情</a>`
  if (o.status === 'pending') {
    return `<a class="link act-pay" data-id="${o.id}">支付</a><a class="link muted act-cancel" data-id="${o.id}">取消</a>${detail}`
  }
  return detail
}

function bindRowActions(): void {
  document
    .querySelectorAll('.act-pay')
    .forEach((el) => el.addEventListener('click', () => void pay((el as HTMLElement).dataset.id!)))
  document
    .querySelectorAll('.act-cancel')
    .forEach((el) =>
      el.addEventListener('click', () => void cancel((el as HTMLElement).dataset.id!))
    )
}

async function refresh(): Promise<void> {
  const res = await fetch('/api/orders')
  orders = (await res.json()) as Order[]
  renderStats()
  renderTable()
}

async function pay(id: string): Promise<void> {
  payTries += 1
  try {
    const res = await fetch(`/api/orders/${id}/pay`, { method: 'POST' })
    if (!res.ok) {
      payFails += 1
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      toast(`支付失败：${body.error ?? res.status}`)
    }
  } catch {
    payFails += 1
    toast('支付失败：网络异常')
  }
  await refresh()
}

async function cancel(id: string): Promise<void> {
  await fetch(`/api/orders/${id}/cancel`, { method: 'POST' })
  await refresh()
}

async function toggleFault(): Promise<void> {
  faultOn = !faultOn
  $('#fault-switch').classList.toggle('on', faultOn)
  await fetch('/__fault', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on: faultOn }),
  })
  await refresh()
}

function toast(message: string): void {
  const el = $('#toast')
  el.textContent = message
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 3200)
}

// ---- 详情视图（hash 路由：#/order/:id）——viewId / 路由面包屑由此产生 ----
function renderRoute(): void {
  const match = location.hash.match(/^#\/order\/([\w-]+)$/)
  const detail = $('#view-detail')
  const list = $('#view-list')
  if (!match) {
    detail.hidden = true
    list.hidden = false
    return
  }
  const order = orders.find((o) => o.id === match[1])
  if (!order) {
    location.hash = ''
    return
  }
  list.hidden = true
  detail.hidden = false
  $('#detail-title').textContent = order.no
  $('#detail-body').innerHTML = `
    <div class="detail-row"><span>商品</span><b>${order.item}</b></div>
    <div class="detail-row"><span>金额</span><b>${money(order.amount as number)}</b></div>
    <div class="detail-row"><span>状态</span>${badge(order.status)}</div>
    <div class="detail-row"><span>创建时间</span><b>${new Date(order.createdAt).toLocaleString()}</b></div>
    <div class="detail-row"><span>状态时间线</span><b>创建 → ${order.status === 'paid' ? '已支付' : order.status === 'cancelled' ? '已取消' : '待支付'}</b></div>`
}

function boot(): void {
  $('#fault-switch').addEventListener('click', () => void toggleFault())
  $('#search').addEventListener('input', (e) => {
    keyword = (e.target as HTMLInputElement).value.trim()
    renderTable()
  })
  $('#btn-new').addEventListener('click', () => $('#modal').classList.add('open'))
  $('#modal-close').addEventListener('click', () => $('#modal').classList.remove('open'))
  $('#order-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = new FormData(e.target as HTMLFormElement)
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: form.get('item'), amount: Number(form.get('amount')) }),
    })
    if (res.ok) {
      $('#modal').classList.remove('open')
      ;(e.target as HTMLFormElement).reset()
      toast('订单已创建')
      await refresh()
    } else {
      const body = (await res.json()) as { error?: string }
      toast(body.error ?? `创建失败 ${res.status}`)
    }
  })
  window.addEventListener('hashchange', renderRoute)
  void refresh().then(renderRoute)
}

boot()
