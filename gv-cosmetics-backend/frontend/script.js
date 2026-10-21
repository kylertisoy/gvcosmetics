/* ═══════════════════════════════════════════
   API LAYER — talks to the FastAPI backend
═══════════════════════════════════════════ */
const API_BASE = window.GVCI_API_BASE || 'http://localhost:8000';

let authToken = localStorage.getItem('gvci_token') || null;

async function apiFetch(path, options = {}) {
  const headers = options.headers || {};
  if (!(options.body instanceof URLSearchParams)) {
    headers['Content-Type'] = 'application/json';
  }
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;

  const res = await fetch(API_BASE + path, { ...options, headers });
  if (!res.ok) {
    let detail = 'Request failed';
    try {
      const body = await res.json();
      if (Array.isArray(body.detail)) {
        // FastAPI validation errors (422): a list of {loc, msg, type} objects —
        // turn them into a readable "field: message" summary instead of [object Object].
        detail = body.detail.map(d => {
          const field = Array.isArray(d.loc) ? d.loc[d.loc.length - 1] : 'field';
          return field + ': ' + d.msg;
        }).join('; ');
      } else if (body.detail) {
        detail = body.detail;
      }
    } catch (e) {}
    throw new Error(detail);
  }
  if (res.status === 204) return null;
  return res.json();
}

/* Local product photos — add more entries here as you get more photos.
   Key = product id, Value = path to the image file in the frontend/images folder. */
const IMAGE_OVERRIDES = {
  1: 'images/michael-styling-gel-sachet-10g.jpg',
  5: 'images/michael-styling-tube-50ml.jpg',
  6: 'images/michael-styling-tube-125ml.jpg',
  7: 'images/shine-n-free-gel-tube-50ml.jpg',
  8: 'images/shine-n-free-gel-tube-100ml.jpg',
    2: 'images/michael-styling-gel-sachet-16g.jpg',
11: 'images/m-hair-spray-pump-pink-125ml.jpg',
12: 'images/m-hair-spray-pump-white-125ml.jpg',
};

/* Renders a product's image if p.image is set, otherwise falls back to the emoji icon */
function productImgHtml(p, size){
  size = size || 52;
  if(p.image){
    return `<img src="${p.image}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover" onerror="this.style.display='none';this.nextElementSibling.style.display='inline'">
            <span style="font-size:${size}px;display:none">${p.e}</span>`;
  }
  return `<span style="font-size:${size}px">${p.e}</span>`;
}

/* Map a backend product (category/emoji/description) to the shape the UI expects (cat/e/desc) */
function mapProduct(p) {
  return { id: p.id, name: p.name, cat: p.category, price: p.price, stock: p.stock, e: p.emoji, image: p.image_url || IMAGE_OVERRIDES[p.id], desc: p.description, badge: p.badge, avg_rating: p.avg_rating, rating_count: p.rating_count, mfg: p.manufacture_date || '', exp: p.expiry_date || '',
           salePrice: p.sale_price > 0 ? p.sale_price : null };
}

/* ═══ SALE / BEST SELLER / NEW ARRIVAL (set by the admin on the Products page) ═══
   - Best Sellers and New Arrivals come from each product's label (p.badge: 'hot' | 'new').
   - A product is ON SALE when the admin has set a sale price below its regular price.
     The same rule runs on the server (orders.py), so the price shown is the price charged. */
function saleActive(p){ return p.salePrice!=null && p.salePrice>0 && p.salePrice<p.price; }
function effPrice(p){ return saleActive(p) ? p.salePrice : p.price; }
function salePct(p){ return saleActive(p) ? Math.round((1-p.salePrice/p.price)*100) : 0; }
function priceHtml(p){
  return saleActive(p) ? '<span class="p-old">'+fmtPeso(p.price)+'</span> '+fmtPeso(p.salePrice) : fmtPeso(p.price);
}

/* Display-only label for order statuses. The underlying value stays 'Shipped'
   everywhere (comparisons, the status-update API call, backend enum) — only
   what's shown to admins/customers reads "For Delivery". */
function statusLabel(status){
  return status==='Shipped' ? 'For Delivery' : status;
}

function formatOrderDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

/* Map a backend order to the shape the UI expects (id=order_number, items=string, etc.) */
function mapOrder(o) {
  return {
    id: o.order_number,
    dbId: o.id,
    customer: o.customer_name || '',
    items: o.items.map(i => i.product_name).join(', '),
    lines: o.items.map(i => ({ productId: i.product_id, name: i.product_name, qty: i.quantity, price: i.unit_price })),
    total: o.total,
    date: formatOrderDate(o.created_at),
    createdAt: o.created_at,
    status: o.status,
    address: o.shipping_address,
    tracking: o.tracking_number,
    cancelReason: o.cancel_reason || null,
    packedAt: o.packed_at || null,
    review: o.review ? { rating: o.review.stars, text: o.review.comment || '', images: o.review.images || [], customer: o.review.customer_name || '' } : null,
  };
}

function mapNotif(n) {
  const iconMap = { processing: '🔄', shipped: '🚚', delivered: '✅', info: '🔔' };
  return {
    id: n.id,
    icon: iconMap[n.type] || '🔔',
    iconClass: n.type,
    title: n.title,
    msg: n.message,
    time: new Date(n.created_at).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit' }),
    read: n.read,
  };
}

/* ═══ STATE (populated from the API after login) ═══ */
let PRODUCTS = [];
let ORDERS_DATA = [];   // admin: all orders
let CUSTOMERS_DATA = [];
let cart={}, myOrders=[], activeCat='All', currentUser=null, editingProductId=null;
let pfImageData=null; // base64 data URL of a newly-picked product image (JPEG), pending save
let wishlist=[], loyaltyPoints=0, productRatings={};
let addresses=[];
let currentPass='', displayName='';
let NOTIFS=[];

/* Runs the startup loaders together but reports WHICH one failed and why, instead
   of one vague message. A failed loader no longer hides the others' data. */
async function loadAllData(loaders){
  const results=await Promise.allSettled(loaders.map(([,fn])=>fn()));
  const failed=[];
  results.forEach((r,i)=>{
    if(r.status!=='rejected') return;
    const name=loaders[i][0], err=r.reason;
    console.error('Failed to load '+name+':',err);
    const msg=(err instanceof TypeError)?'server unreachable ('+API_BASE+')':(err&&err.message)||'request failed';
    failed.push(name+': '+msg);
  });
  if(failed.length) showToast('⚠️ Could not load '+failed.join(' | '));
  return failed.length===0;
}

/* Fetch products + ratings from the API */
async function loadProducts() {
  const data = await apiFetch('/products');
  PRODUCTS = data.map(mapProduct);
  productRatings = {};
  PRODUCTS.forEach(p => {
    if (p.rating_count > 0) {
      productRatings[p.id] = { avg: p.avg_rating.toFixed(1), count: p.rating_count, userRating: 0 };
    }
  });
}

/* Fetch the customer's wishlist product ids */
async function loadWishlist() {
  const data = await apiFetch('/wishlist');
  wishlist = data.map(p => p.id);
}

/* Fetch the customer's own orders (or all orders for admin) */
async function loadOrders() {
  const data = await apiFetch('/orders');
  const mapped = data.map(mapOrder);
  if (currentUser && currentUser.role === 'admin') {
    ORDERS_DATA = mapped;
    if (typeof updatePackingBadge === 'function') updatePackingBadge();
  } else {
    myOrders = mapped;
  }
}

/* ═══ PHILIPPINE LOCATION DATA (Region → Province → City → Barangay) ═══ */
const PH_LOCATIONS = {
  "Metro Manila": {
    "Metro Manila": {
      "Quezon City": ["Commonwealth","Batasan Hills","Fairview","Diliman","Novaliches","Cubao"],
      "Manila": ["Ermita","Malate","Sampaloc","Tondo","Binondo","Sta. Cruz"],
      "Makati": ["Poblacion","Bel-Air","San Lorenzo","Guadalupe Nuevo","Bangkal"],
      "Pasig": ["Kapitolyo","Ortigas Center","Ugong","Bagong Ilog","San Antonio"],
      "Taguig": ["Bonifacio Global City","Ususan","Hagonoy","Bagumbayan"],
      "Mandaluyong": ["Highway Hills","Wack-Wack","Barangka","Plainview"],
      "Pasay": ["Malibay","Maricaban","San Rafael","Libertad"],
      "Caloocan": ["Poblacion","Bagong Silang","Camarin","Grace Park"]
    }
  },
  "North Luzon": {
    "Pangasinan": { "Dagupan City": ["Bonuan Boquig","Lucao","Pantal","Mayombo"], "Urdaneta City": ["Poblacion","Nancayasan","Cayambanan"], "Lingayen": ["Poblacion","Baay","Domalandan"] },
    "La Union": { "San Fernando City": ["Poro","Catbangen","Carlatan","Bacsil"], "Bauang": ["Central East","Paringao","Payocpoc"] },
    "Ilocos Norte": { "Laoag City": ["San Lorenzo","Barit","Cabungaan"], "Batac": ["Poblacion","Payao"] },
    "Cagayan": { "Tuguegarao City": ["Centro","Caritan","Ugac","Pallua"], "Aparri": ["Poblacion","Maura"] },
    "Benguet": { "Baguio City": ["Session Road Area","Camp 7","Trancoville","Pinsao","Loakan"], "La Trinidad": ["Poblacion","Balili","Wangal"] },
    "Bulacan": { "Malolos City": ["Poblacion","Sto. Rosario","Longos"], "Meycauayan": ["Poblacion","Banga","Calvario"] },
    "Pampanga": { "Angeles City": ["Balibago","Malabanias","Cutcut","Pulung Maragul"], "San Fernando City": ["Dolores","San Jose","Sto. Niño"] },
    "Tarlac": { "Tarlac City": ["San Roque","Sto. Cristo","San Sebastian"], "Concepcion": ["Poblacion"] }
  },
  "South Luzon": {
    "Cavite": { "Dasmariñas City": ["Salawag","Zone I Poblacion","San Agustin"], "Bacoor City": ["Molino","Talaba","Zapote"], "Imus City": ["Anabu","Bucandala","Malagasang"] },
    "Laguna": { "Calamba City": ["Real","Canlubang","Halang","Bucal"], "Santa Rosa City": ["Balibago","Market Area","Tagapo"], "San Pablo City": ["Poblacion","Sta. Maria"] },
    "Batangas": { "Batangas City": ["Poblacion","Kumintang Ibaba","Alangilan"], "Lipa City": ["Poblacion","Sabang","Marauoy"] },
    "Rizal": { "Antipolo City": ["San Roque","Dela Paz","Mayamot","Muntindilaw"], "Cainta": ["San Isidro","Sto. Domingo"] },
    "Quezon": { "Lucena City": ["Poblacion","Ilayang Dupay","Isabang"], "Tayabas City": ["Poblacion"] },
    "Camarines Sur": { "Naga City": ["Concepcion Pequeña","Peñafrancia","Triangulo"], "Iriga City": ["San Nicolas","San Roque"] },
    "Palawan": { "Puerto Princesa City": ["San Pedro","Sta. Monica","Tiniguiban","Bancao-Bancao"] }
  },
  "Visayas": {
    "Cebu": { "Cebu City": ["Lahug","Guadalupe","Talamban","Mabolo","Banilad"], "Mandaue City": ["Subangdaku","Tipolo","Basak"], "Lapu-Lapu City": ["Poblacion","Pusok","Gun-ob"] },
    "Bohol": { "Tagbilaran City": ["Poblacion I","Cogon","Dao"], "Panglao": ["Poblacion","Tawala"] },
    "Negros Oriental": { "Dumaguete City": ["Poblacion","Piapi","Bantayan","Camanjac"] },
    "Negros Occidental": { "Bacolod City": ["Villamonte","Mandalagan","Singcang-Airport","Taculing"] },
    "Iloilo": { "Iloilo City": ["Jaro","Molo","Mandurriao","La Paz"] },
    "Leyte": { "Tacloban City": ["Sagkahan","San Jose","Abucay"] }
  },
  "Mindanao": {
    "Misamis Oriental": {
      "Alubijid": ["Baybay", "Benigwayan", "Calatcat", "Lagtang", "Lanao", "Loguilo", "Lourdes", "Lumbo", "Molocboloc", "Poblacion", "Sampatulog", "Sungay", "Talaba", "Taparak", "Tugasnon", "Tula"],
      "Balingasag": ["Balagnan", "Baliwagan", "Barangay 1", "Barangay 2", "Barangay 3", "Barangay 4", "Barangay 5", "Barangay 6", "Binitinan", "Blanco", "Calawag", "Camuayan", "Cogon", "Dansuli", "Dumarait", "Hermano", "Kibanban", "Linabu", "Linggangao", "Mambayaan", "Mandangoa", "Napaliran", "Quezon", "Rosario", "Samay", "San Francisco", "San Isidro", "San Juan", "Talusan", "Waterfall"],
      "Balingoan": ["Baukbauk Poblacion", "Dahilig", "Kabangasan", "Kabulakan", "Kauswagan", "Lapinig", "Mantangale", "Mapua", "San Alonzo"],
      "Binuangan": ["Dampias", "Kitamban", "Kitambis", "Mabini", "Mosangot", "Nabataan", "Poblacion", "Valdeconcha"],
      "Cagayan de Oro City": ["Agusan", "Baikingon", "Balubal", "Balulang", "Barangay 1", "Barangay 2", "Barangay 3", "Barangay 4", "Barangay 5", "Barangay 6", "Barangay 7", "Barangay 8", "Barangay 9", "Barangay 10", "Barangay 11", "Barangay 12", "Barangay 13", "Barangay 14", "Barangay 15", "Barangay 16", "Barangay 17", "Barangay 18", "Barangay 19", "Barangay 20", "Barangay 21", "Barangay 22", "Barangay 23", "Barangay 24", "Barangay 25", "Barangay 26", "Barangay 27", "Barangay 28", "Barangay 29", "Barangay 30", "Barangay 31", "Barangay 32", "Barangay 33", "Barangay 34", "Barangay 35", "Barangay 36", "Barangay 37", "Barangay 38", "Barangay 39", "Barangay 40", "Bayabas", "Bayanga", "Besigan", "Bonbon", "Bugo", "Bulua", "Camaman-an", "Canito-an", "Carmen", "Consolacion", "Cugman", "Dansolihon", "F. S. Catanico", "Gusa", "Indahag", "Iponan", "Kauswagan", "Lapasan", "Lumbia", "Macabalan", "Macasandig", "Mambuaya", "Nazareth", "Pagalungan", "Pagatpat", "Patag", "Pigsag-an", "Puerto", "Puntod", "San Simon", "Tablon", "Taglimao", "Tagpangi", "Tignapoloan", "Tuburan", "Tumpagon"],
      "Claveria": ["Ani-e", "Aposkahoy", "Bulahan", "Cabacungan", "Gumaod", "Hinaplanan", "Kalawitan", "Lanise", "Luna", "Madaguing", "Malagana", "Mat-i", "Minalwang", "Pambugas", "Panampawan", "Patrocenio", "Pelaez", "Plaridel", "Poblacion", "Punong", "Rizal", "Santa Cruz", "Tamboboan", "Tipolohon"],
      "El Salvador City": ["Amoros", "Bolisong", "Bolobolo", "Calongonan", "Cogon", "Himaya", "Hinigdaan", "Kalabaylabay", "Kibonbon", "Molugan", "Poblacion", "Sambulawan", "Sinaloc", "Taytay", "Ulaliman"],
      "Gingoog City": ["Agay-ayan", "Alagatan", "Anakan", "Bagubad", "Bakidbakid", "Bal-ason", "Bantaawan", "Barangay 1", "Barangay 2", "Barangay 3", "Barangay 4", "Barangay 5", "Barangay 6", "Barangay 7", "Barangay 8", "Barangay 9", "Barangay 10", "Barangay 11", "Barangay 12", "Barangay 13", "Barangay 14", "Barangay 15", "Barangay 16", "Barangay 17", "Barangay 18", "Barangay 18-A", "Barangay 19", "Barangay 20", "Barangay 21", "Barangay 22", "Barangay 22-A", "Barangay 23", "Barangay 24", "Barangay 24-A", "Barangay 25", "Barangay 26", "Binakalan", "Capitulangan", "Daan-Lungsod", "Dinawehan", "Eureka", "Hindangon", "Kalagonoy", "Kalipay", "Kamanikan", "Kianlagan", "Kibuging", "Kipuntos", "Lawaan", "Lawit", "Libertad", "Libon", "Lunao", "Lunotan", "Malibud", "Malinao", "Maribucao", "Mimbalagon", "Mimbunga", "Mimbuntong", "Minsapinit", "Murallon", "Odiongan", "Pangasihan", "Pigsaluhan", "Punong", "Ricoro", "Samay", "San Jose", "San Juan", "San Luis", "San Miguel", "Sangalan", "Santiago", "Tagpako", "Talisay", "Talon", "Tinabalan", "Tinulongan"],
      "Gitagum": ["Burnay", "Carlos P. Garcia", "Cogon", "Gregorio Pelaez", "Kilangit", "Matangad", "Pangayawan", "Poblacion", "Quezon", "Tala-o", "Ulab"],
      "Initao": ["Aluna", "Andales", "Apas", "Calacapan", "Gimangpang", "Jampason", "Kamelon", "Kanitoan", "Oguis", "Pagahan", "Poblacion", "Pontacon", "San Pedro", "Sinalac", "Tawantawan", "Tubigan"],
      "Jasaan": ["Aplaya", "Bobontugan", "Corrales", "Danao", "I. S. Cruz", "Jampason", "Kimaya", "Lower Jasaan", "Luz Banzon", "Natubo", "San Antonio", "San Isidro", "San Nicolas", "Solana", "Upper Jasaan"],
      "Kinoguitan": ["Beray", "Bolisong", "Buko", "Calubo", "Campo", "Esperanza", "Kagumahan", "Kalitian", "Kitotok", "Panabol", "Poblacion", "Salicapawan", "Salubsob", "Suarez", "Sumalag"],
      "Lagonglong": ["Banglay", "Dampil", "Gaston", "Kabulawan", "Kauswagan", "Lumbo", "Manaol", "Poblacion", "Tabok", "Umagos"],
      "Laguindingan": ["Aromahon", "Gasi", "Kibaghot", "Lapad", "Liberty", "Mauswagon", "Moog", "Poblacion", "Sambulawan", "Sinai", "Tubajon"],
      "Libertad": ["Dulong", "Gimaylan", "Kimalok", "Lubluban", "Poblacion", "Retablo", "Santo Niño", "Tangcub", "Taytayan"],
      "Lugait": ["Aya-aya", "Betahon", "Biga", "Calangahan", "Kaluknayan", "Lower Talacogon", "Poblacion", "Upper Talacogon"],
      "Magsaysay": ["Abunda", "Artadi", "Bonifacio Aquino", "Cabalawan", "Cabantian", "Cabubuhan", "Candiis", "Consuelo", "Damayuhan", "Gumabon", "Katipunan", "Kauswagan", "Kibungsod", "Mahayahay", "Mindulao", "Pag-asa", "Poblacion", "San Isidro", "San Vicente", "Santa Cruz", "Tama", "Tibon-tibon", "Tinaan", "Tulang", "Villa Felipa"],
      "Manticao": ["Argayoso", "Balintad", "Cabalantian", "Camanga", "Digkilaan", "Mahayahay", "Pagawan", "Paniangan", "Patag", "Poblacion", "Punta Silum", "Tuod", "Upper Malubog"],
      "Medina": ["Bangbang", "Bulwa", "Cabug", "Dig-aguyan", "Duka", "Gasa", "Maanas", "Mananum Bag-o", "Mananum Daan", "North Poblacion", "Pahindong", "Portulin", "San Isidro", "San Jose", "San Roque", "San Vicente", "South Poblacion", "Tambagan", "Tup-on"],
      "Naawan": ["Don Pedro", "Linangkayan", "Lubilan", "Mapulog", "Maputi", "Mat-i", "Patag", "Poblacion", "Tagbalogo", "Tuboran"],
      "Opol": ["Awang", "Bagocboc", "Barra", "Bonbon", "Cauyonan", "Igpit", "Limonda", "Luyongbonbon", "Malanang", "Nangcaon", "Patag", "Poblacion", "Taboc", "Tingalan"],
      "Salay": ["Alipuaton", "Ampenican", "Bunal", "Casulog", "Dinagsaan", "Guinalaban", "Ili-ilihon", "Inobulan", "Looc", "Matampa", "Membuli", "Poblacion", "Salagsag", "Salay River I", "Salay River II", "Saray", "Tinagaan", "Yungod"],
      "Sugbongcogon": ["Alicomohan", "Ampianga", "Kaulayanan", "Kidampas", "Kiraging", "Mangga", "Mimbuahan", "Poblacion", "Santa Cruz", "Silad"],
      "Tagoloan": ["Baluarte", "Casinglot", "Gracia", "Mohon", "Natumolan", "Poblacion", "Rosario", "Santa Ana", "Santa Cruz", "Sugbongcogon"],
      "Talisayan": ["Bugdang", "Calamcam", "Casibole", "Macopa", "Magkarila", "Mahayag", "Mandahilag", "Mintabon", "Pangpangon", "Poblacion", "Pook", "Punta Santiago", "Puting Balas", "San Jose", "Santa Ines", "Sibantang", "Sindangan", "Tagbocboc"],
      "Villanueva": ["Balacanas", "Dayawan", "Imelda", "Katipunan", "Kimaya", "Looc", "Poblacion 1", "Poblacion 2", "Poblacion 3", "San Martin", "Tambobong"]
    },
    "Misamis Occidental": { "Ozamiz City": ["Poblacion"], "Tangub City": ["Poblacion"] },
    "Bukidnon": { "Malaybalay City": ["Poblacion","Casisang","Sumpong"], "Valencia City": ["Poblacion","Bagontaas"] },
    "Davao del Sur": { "Davao City": ["Buhangin","Talomo","Agdao","Matina","Bunawan","Toril"], "Digos City": ["Poblacion"] },
    "South Cotabato": { "General Santos City": ["Lagao","Dadiangas","Bula","Calumpang"], "Koronadal City": ["Poblacion"] },
    "Zamboanga del Sur": { "Zamboanga City": ["Tetuan","Guiwan","Sta. Maria","Tumaga"], "Pagadian City": ["Poblacion"] },
    "Lanao del Norte": { "Iligan City": ["Poblacion","Tibanga","Pala-o","Tominobo"] },
    "Agusan del Norte": { "Butuan City": ["Libertad","Baan Km 3","Ambago"] },
    "Surigao del Norte": { "Surigao City": ["Poblacion","Washington","Luna"] },
    "Maguindanao": { "Cotabato City": ["Poblacion","Rosary Heights"] }
  }
};

/* Reusable Region → Province → City → Barangay picker, shared by the
   checkout page (co-city/co-prov) and the profile Add-Address form
   (addr-city/addr-province). Only City + Province get persisted (that's
   all the backend stores); Barangay, if picked, is just used to prefill
   the Street field as a convenience. */
let LOC_CTX=null;
let LOC_STATE={region:null,province:null,city:null,barangay:null};
let LOC_TAB='region';

function findLocationMatch(city,prov){
  if(!city && !prov) return null;
  for(const region in PH_LOCATIONS){
    for(const province in PH_LOCATIONS[region]){
      if(prov && province.toLowerCase()!==prov.trim().toLowerCase()) continue;
      const cities=PH_LOCATIONS[region][province];
      for(const c in cities){
        if(city && c.toLowerCase()===city.trim().toLowerCase()) return {region,province,city:c,barangay:null};
      }
    }
  }
  return null;
}

function openLocationPicker(ctx,startTab){
  LOC_CTX=ctx;
  const cityId = ctx==='checkout' ? 'co-city' : 'addr-city';
  const provId = ctx==='checkout' ? 'co-prov' : 'addr-province';
  const curCity=document.getElementById(cityId).value;
  const curProv=document.getElementById(provId).value;
  LOC_STATE = findLocationMatch(curCity,curProv) || {region:null,province:null,city:null,barangay:null};
  LOC_TAB = LOC_STATE.region ? (LOC_STATE.province ? 'city' : 'province') : 'region';
  // Add-Address form: restore the barangay that's already picked, and let the
  // Barangay field jump straight to the Barangay tab once a city is chosen.
  if(ctx==='addr'){
    const curBrgy=(document.getElementById('addr-barangay')?.value||'').trim();
    if(LOC_STATE.city && curBrgy){
      const list=(PH_LOCATIONS[LOC_STATE.region]?.[LOC_STATE.province]?.[LOC_STATE.city])||[];
      if(list.includes(curBrgy)) LOC_STATE.barangay=curBrgy;
    }
    if(startTab==='barangay' && LOC_STATE.city) LOC_TAB='barangay';
  }
  renderLocationPicker();
  document.getElementById('loc-overlay').classList.add('show');
}
function closeLocationPicker(){
  document.getElementById('loc-overlay').classList.remove('show');
}
function locGoTab(tab){
  if(tab==='province' && !LOC_STATE.region) return;
  if(tab==='city' && !LOC_STATE.province) return;
  if(tab==='barangay' && !LOC_STATE.city) return;
  LOC_TAB=tab;
  renderLocationPicker();
}
function locSelect(level,value){
  LOC_STATE[level]=value;
  if(level==='region'){LOC_STATE.province=null;LOC_STATE.city=null;LOC_STATE.barangay=null;LOC_TAB='province';}
  else if(level==='province'){LOC_STATE.city=null;LOC_STATE.barangay=null;LOC_TAB='city';}
  else if(level==='city'){LOC_STATE.barangay=null;LOC_TAB='barangay';}
  renderLocationPicker();
}
function locApply(){
  if(!LOC_STATE.city||!LOC_STATE.province)return;
  const cityId = LOC_CTX==='checkout' ? 'co-city' : 'addr-city';
  const provId = LOC_CTX==='checkout' ? 'co-prov' : 'addr-province';
  document.getElementById(cityId).value = LOC_STATE.city;
  document.getElementById(provId).value = LOC_STATE.province;
  if(LOC_CTX==='checkout'){ clearFieldError('co-city'); clearFieldError('co-prov'); }
  if(LOC_CTX==='addr'){
    const brgyEl=document.getElementById('addr-barangay');
    if(brgyEl) brgyEl.value=LOC_STATE.barangay||'';   // cleared if the city changed
  }
  closeLocationPicker();
}
function renderLocationPicker(){
  const tabs=['region','province','city','barangay'];
  const labels={region:'Region',province:'Province',city:'City',barangay:'Barangay'};
  const tabsHtml=tabs.map(t=>{
    const enabled = t==='region' || (t==='province'&&LOC_STATE.region) || (t==='city'&&LOC_STATE.province) || (t==='barangay'&&LOC_STATE.city);
    return `<div class="loc-tab ${LOC_TAB===t?'active':''} ${enabled?'':'disabled'}" onclick="locGoTab('${t}')">${labels[t]}</div>`;
  }).join('');

  let items=[];
  if(LOC_TAB==='region') items=Object.keys(PH_LOCATIONS);
  else if(LOC_TAB==='province') items = LOC_STATE.region ? Object.keys(PH_LOCATIONS[LOC_STATE.region]) : [];
  else if(LOC_TAB==='city') items = (LOC_STATE.region&&LOC_STATE.province) ? Object.keys(PH_LOCATIONS[LOC_STATE.region][LOC_STATE.province]) : [];
  else if(LOC_TAB==='barangay') items = (LOC_STATE.region&&LOC_STATE.province&&LOC_STATE.city) ? PH_LOCATIONS[LOC_STATE.region][LOC_STATE.province][LOC_STATE.city] : [];

  const selectedVal=LOC_STATE[LOC_TAB];
  const listHtml = items.length
    ? items.map(i=>`<div class="loc-item ${i===selectedVal?'selected':''}" onclick="locSelect('${LOC_TAB}','${i.replace(/'/g,"\\'")}')">${i}</div>`).join('')
    : `<div class="loc-empty-hint">Select a ${labels[tabs[tabs.indexOf(LOC_TAB)-1]]||'region'} first.</div>`;

  document.getElementById('loc-tabs').innerHTML=tabsHtml;
  document.getElementById('loc-list').innerHTML=listHtml;
  document.getElementById('loc-btn-done').disabled = !LOC_STATE.city;
}

/* Barangay is stored in its own field. These helpers build the readable street
   line ("123 Rizal St., Brgy. Poblacion") for cards, checkout and orders. Older
   addresses that already have the barangay typed into the street are left as-is. */
function brgyLabel(b){ return /^barangay\s/i.test(b) ? b : 'Brgy. '+b; }
function streetWithBrgy(street, barangay){
  if(!barangay) return street;
  const low=String(street||'').toLowerCase(), b=barangay.toLowerCase();
  const has=[brgyLabel(barangay).toLowerCase(),'brgy '+b,'brgy.'+b,'barangay '+b].some(x=>low.includes(x));
  return has ? street : street+', '+brgyLabel(barangay);
}

async function loadAddresses() {
  const data = await apiFetch('/addresses');
  addresses = data.map(a => ({ id: a.id, name: a.name, phone: a.phone, street: a.street, barangay: a.barangay || '', city: a.city, province: a.province, zip: a.zip, label: a.label, isDefault: a.is_default }));
}

async function loadNotifications() {
  const data = await apiFetch('/notifications');
  NOTIFS = data.map(mapNotif);
}

async function loadCustomers() {
  const data = await apiFetch('/customers');
  CUSTOMERS_DATA = data;
}

/* ═══ TOAST ═══ */
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}

/* ═══ LOGIN ═══ */
// topbar scroll shadow
window.addEventListener('scroll',function(){
  const tb=document.getElementById('c-topbar-el');
  if(tb){tb.classList.toggle('scrolled',window.scrollY>10);}
});

function showSignup(){
  document.getElementById('login-form-wrap').classList.add('hidden');
  document.getElementById('forgot-form-wrap')?.classList.add('hidden');
  document.getElementById('signup-form-wrap').classList.remove('hidden');
  document.getElementById('su-err').style.display='none';
}
function showLoginForm(){
  document.getElementById('signup-form-wrap').classList.add('hidden');
  document.getElementById('forgot-form-wrap')?.classList.add('hidden');
  clearInterval(fpTimer);
  document.getElementById('login-form-wrap').classList.remove('hidden');
}

/* ═══ FORGOT PASSWORD ═══
   Step 1: customer enters the email they signed up with -> POST /auth/forgot-password
           (the backend emails a 6-digit code to that address).
   Step 2: they enter the code + a new password          -> POST /auth/reset-password
   The new password must follow the same rules as signup. */
let fpEmail='', fpTimer=null, fpSecondsLeft=0;

function fpShowErr(step,msg){
  const el=document.getElementById('fp-err'+step);
  el.textContent='❌ '+msg; el.style.display='block';
}
function fpClearErr(){
  ['fp-err1','fp-err2'].forEach(id=>{ const el=document.getElementById(id); if(el) el.style.display='none'; });
}
function showForgot(){
  document.getElementById('login-form-wrap').classList.add('hidden');
  document.getElementById('signup-form-wrap').classList.add('hidden');
  document.getElementById('forgot-form-wrap').classList.remove('hidden');
  document.getElementById('fp-step1').classList.remove('hidden');
  document.getElementById('fp-step2').classList.add('hidden');
  document.getElementById('fp-intro').style.display='';
  ['fp-code','fp-pass','fp-pass2'].forEach(id=>{ document.getElementById(id).value=''; });
  document.getElementById('fp-email').value=document.getElementById('inp-email').value.trim();
  fpClearErr();
  clearInterval(fpTimer);
  document.getElementById('fp-email').focus();
}

/* Asks the backend to email a code. Returns true if the request went through. */
async function fpRequestCode(email,btn,busyText){
  const old=btn?btn.textContent:'';
  if(btn){ btn.disabled=true; btn.textContent=busyText; }
  try {
    await apiFetch('/auth/forgot-password',{ method:'POST', body: JSON.stringify({ email }) });
    return true;
  } catch(e){
    return e.message||'Could not send the code. Please try again.';
  } finally {
    if(btn){ btn.disabled=false; btn.textContent=old; }
  }
}
async function fpSendCode(){
  fpClearErr();
  const email=document.getElementById('fp-email').value.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ fpShowErr(1,'Please enter a valid email address.'); return; }
  const res=await fpRequestCode(email,document.getElementById('fp-send-btn'),'Sending...');
  if(res!==true){ fpShowErr(1,res); return; }
  fpEmail=email;
  document.getElementById('fp-step1').classList.add('hidden');
  document.getElementById('fp-step2').classList.remove('hidden');
  document.getElementById('fp-intro').style.display='none';
  document.getElementById('fp-ok').textContent='If '+email+' has an account, we sent a 6-digit code to it. The code expires in 10 minutes. Please check your Spam or Junk folder too.';
  fpStartCooldown(60);
  document.getElementById('fp-code').focus();
}
function fpStartCooldown(seconds){
  const link=document.getElementById('fp-resend');
  clearInterval(fpTimer);
  fpSecondsLeft=seconds;
  const tick=()=>{
    if(fpSecondsLeft>0){ link.classList.add('disabled'); link.textContent='Resend code in '+fpSecondsLeft+'s'; fpSecondsLeft--; }
    else { clearInterval(fpTimer); link.classList.remove('disabled'); link.textContent='Resend code'; }
  };
  tick();
  fpTimer=setInterval(tick,1000);
}
async function fpResend(){
  if(fpSecondsLeft>0||!fpEmail) return;
  fpClearErr();
  const res=await fpRequestCode(fpEmail,null,'');
  if(res!==true){ fpShowErr(2,res); return; }
  showToast('📧 We sent you a new code.');
  fpStartCooldown(60);
}
async function fpReset(){
  fpClearErr();
  const code=document.getElementById('fp-code').value.trim();
  const p1=document.getElementById('fp-pass').value;
  const p2=document.getElementById('fp-pass2').value;
  if(!/^\d{6}$/.test(code)){ fpShowErr(2,'Enter the 6-digit code from your email.'); return; }
  if(p1.length<6){ fpShowErr(2,'Password must be at least 6 characters.'); return; }
  if(!/[A-Z]/.test(p1)){ fpShowErr(2,'Password must include at least 1 capital letter.'); return; }
  if(!/[^A-Za-z0-9]/.test(p1)){ fpShowErr(2,'Password must include at least 1 special character (e.g. ! @ # $ %).'); return; }
  if(p1!==p2){ fpShowErr(2,'Passwords do not match.'); return; }

  const btn=document.getElementById('fp-reset-btn');
  btn.disabled=true; btn.textContent='Updating...';
  try {
    await apiFetch('/auth/reset-password',{ method:'POST', body: JSON.stringify({ email: fpEmail, code, new_password: p1 }) });
  } catch(e){
    fpShowErr(2,e.message||'Could not reset the password.');
    btn.disabled=false; btn.textContent='Reset Password →';
    return;
  }
  btn.disabled=false; btn.textContent='Reset Password →';
  showToast('✅ Password updated. Please sign in with your new password.');
  const emailForLogin=fpEmail;
  ['fp-code','fp-pass','fp-pass2'].forEach(id=>{ document.getElementById(id).value=''; });
  showLoginForm();
  document.getElementById('inp-email').value=emailForLogin;
  document.getElementById('inp-pass').value='';
  document.getElementById('inp-pass').focus();
}

/* ═══ NAME FIELDS: letters only (spaces, hyphens, apostrophes still allowed
   for names like "Dela Cruz" or "O'Brien") — strips anything else as it's
   typed or pasted, so numbers simply can't end up in a name field. ═══ */
function restrictToLetters(e){
  const el=e.target;
  const start=el.selectionStart, end=el.selectionEnd;
  const cleaned=el.value.replace(/[^A-Za-z\s'-]/g,'');
  if(cleaned!==el.value){
    const removedBefore=el.value.slice(0,start).length - el.value.slice(0,start).replace(/[^A-Za-z\s'-]/g,'').length;
    el.value=cleaned;
    const pos=Math.max(0,start-removedBefore);
    el.setSelectionRange(pos,pos);
  }
}
function attachLetterOnlyFields(ids){
  ids.forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('input', restrictToLetters);
  });
}
// Static fields present at page load: signup name, profile first/last name, new-address name
attachLetterOnlyFields(['su-name','pf-fname','pf-lname','addr-name']);

/* ═══ PHONE FIELDS: numbers only, no letters — strips anything else as
   it's typed or pasted (a leading "+" for country codes is still allowed). ═══ */
function restrictToDigits(e){
  const el=e.target;
  const start=el.selectionStart;
  const cleaned=el.value.replace(/[^\d+]/g,'').replace(/(?!^)\+/g,'');
  if(cleaned!==el.value){
    const removedBefore=el.value.slice(0,start).length - el.value.slice(0,start).replace(/[^\d+]/g,'').replace(/(?!^)\+/g,'').length;
    el.value=cleaned;
    const pos=Math.max(0,start-removedBefore);
    el.setSelectionRange(pos,pos);
  }
}
function attachDigitOnlyFields(ids){
  ids.forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('input', restrictToDigits);
  });
}
// Static field present at page load: new-address phone
attachDigitOnlyFields(['addr-phone']);

/* ═══ SIGNUP PASSWORD HINT: shows the rule up front (1 capital + 1 special
   character required) instead of the customer only finding out after an
   error, and updates the placeholder to match. ═══ */
(function addSignupPasswordHint(){
  const passField=document.getElementById('su-pass');
  if(!passField) return;
  passField.placeholder='At least 6 chars, 1 capital & 1 special character';
  const hint=document.createElement('div');
  hint.id='su-pass-hint';
  hint.style.cssText='font-size:11px;color:var(--muted);margin-top:4px;line-height:1.5';
  hint.textContent='Must be at least 6 characters and include at least 1 capital letter (A-Z) and 1 special character (e.g. ! @ # $ %). Accounts that don\'t meet this won\'t be created.';
  passField.insertAdjacentElement('afterend', hint);
})();

async function doRegister(){
  const name=document.getElementById('su-name').value.trim();
  const email=document.getElementById('su-email').value.trim().toLowerCase();
  const pass=document.getElementById('su-pass').value;
  const pass2=document.getElementById('su-pass2').value;
  const err=document.getElementById('su-err');

  const showErr=(msg)=>{err.textContent='❌ '+msg;err.style.display='block';};

  if(!name||!email||!pass){showErr('Please fill in all fields.');return;}
  if(pass.length<6){showErr('Password must be at least 6 characters.');return;}
  if(!/[A-Z]/.test(pass)){showErr('Password must include at least 1 capital letter.');return;}
  if(!/[^A-Za-z0-9]/.test(pass)){showErr('Password must include at least 1 special character (e.g. ! @ # $ %).');return;}
  if(pass!==pass2){showErr('Passwords do not match.');return;}

  let data;
  try {
    data = await apiFetch('/auth/register', {
      method:'POST',
      body: JSON.stringify({ name, email, password: pass })
    });
  } catch(e) {
    showErr(e.message||'Could not create account.');
    return;
  }
  err.style.display='none';

  // Registration no longer returns a token/user — new customer accounts are
  // created as 'pending' and need an admin to approve them before they can log in.
  showToast('✅ '+(data.detail||'Account created. Please wait for admin approval.'));

  // reset the signup form + switch back to login view for next time
  document.getElementById('su-name').value='';
  document.getElementById('su-email').value='';
  document.getElementById('su-pass').value='';
  document.getElementById('su-pass2').value='';
  showLoginForm();
}

async function doLogin(){
  const email=document.getElementById('inp-email').value.trim().toLowerCase();
  const pass=document.getElementById('inp-pass').value;
  const err=document.getElementById('err-msg');

  let data;
  try {
    const form = new URLSearchParams();
    form.set('username', email);
    form.set('password', pass);
    data = await apiFetch('/auth/login', { method: 'POST', body: form });
  } catch (e) {
    err.style.display='block';
    return;
  }
  err.style.display='none';

  authToken = data.access_token;
  localStorage.setItem('gvci_token', authToken);
  const acc = data.user; // {id,email,name,initials,role,loyalty_points}
  currentUser = acc;
  loyaltyPoints = acc.loyalty_points || 0;
  displayName = acc.name;
  currentPass = pass;

  document.getElementById('screen-login').classList.add('hidden');
  if(acc.role==='customer'){
    document.getElementById('screen-customer').classList.remove('hidden');
    document.getElementById('c-avatar').textContent=acc.initials;
    document.getElementById('prof-avatar-big').textContent=acc.initials;
    document.getElementById('c-username').textContent=acc.name.split(' ')[0];
    await loadAllData([['products',loadProducts], ['wishlist',loadWishlist], ['orders',loadOrders], ['addresses',loadAddresses], ['notifications',loadNotifications]]);
    loadCartFromStorage();updatePill();buildShop();renderAddrList();buildRecommendations();updateWishlistBadge();updateNotifBell();renderWishlist();
  } else {
    document.getElementById('screen-admin').classList.remove('hidden');
    await loadAllData([['products',loadProducts], ['orders',loadOrders], ['customers',loadCustomers]]);
    buildAdminAll();
  }
}

function doLogout(){
  disposeInlineTracks();
  currentUser=null;cart={};cartFromWishlist={};myOrders=[];activeCat='All';
  authToken=null;localStorage.removeItem('gvci_token');
  document.getElementById('inp-email').value='';
  document.getElementById('inp-pass').value='';
  document.getElementById('screen-customer').classList.add('hidden');
  document.getElementById('screen-admin').classList.add('hidden');
  document.getElementById('screen-login').classList.remove('hidden');
  showToast('Logged out. See you soon! 💄');
}

function applyProfileToUI(acc){
  const parts = acc.name.trim().split(' ');
  const fname = parts[0] || '';
  const lname = parts.slice(1).join(' ') || '';

  document.getElementById('prof-display-name').textContent = acc.name;
  document.getElementById('prof-display-email').textContent = acc.email;

  const pfF = document.getElementById('pf-fname');
  const pfL = document.getElementById('pf-lname');
  const pfE = document.getElementById('pf-email');
  if(pfF) pfF.value = fname;
  if(pfL) pfL.value = lname;
  if(pfE) pfE.value = acc.email;
}

/* ═══ NOTIFICATIONS ═══ */
function pushNotif(icon,iconClass,title,msg){
  NOTIFS.unshift({id:Date.now(),icon,iconClass,title,msg,time:new Date().toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit'}),read:false});
  updateNotifBell();renderNotifList();
}
function updateNotifBell(){
  const unread=NOTIFS.filter(n=>!n.read).length;
  const dot=document.getElementById('notif-dot');
  if(!dot)return;
  if(unread>0){dot.textContent=unread;dot.classList.add('on');}
  else{dot.classList.remove('on');}
}
function renderNotifList(){
  const el=document.getElementById('notif-list');if(!el)return;
  if(!NOTIFS.length){el.innerHTML='<div class="notif-empty"><div class="notif-empty-icon">🔔</div>No notifications yet</div>';return;}
  el.innerHTML=NOTIFS.map(n=>`
    <div class="notif-item ${n.read?'':'unread'}">
      <div class="ni-icon ${n.iconClass}">${n.icon}</div>
      <div class="ni-body"><div class="ni-title">${n.title}</div><div class="ni-msg">${n.msg}</div><div class="ni-time">${n.time}</div></div>
      ${!n.read?'<div class="ni-unread-dot"></div>':''}
    </div>`).join('');
}
async function toggleNotifPanel(e){
  e.stopPropagation();
  const panel=document.getElementById('notif-panel');
  panel.classList.toggle('open');
  if(panel.classList.contains('open')){
    try { await loadNotifications(); } catch(e){}
    updateNotifBell();renderNotifList();
  }
}
async function markAllRead(){
  const unread=NOTIFS.filter(n=>!n.read);
  try { await Promise.all(unread.map(n=>apiFetch('/notifications/'+n.id+'/read',{method:'PATCH'}))); } catch(e){}
  NOTIFS.forEach(n=>n.read=true);updateNotifBell();renderNotifList();
}
document.addEventListener('click',function(e){
  const panel=document.getElementById('notif-panel');
  if(panel&&panel.classList.contains('open')&&!panel.contains(e.target)&&!e.target.closest('.notif-bell')){panel.classList.remove('open');}
});

/* ═══ SHOP ═══ */
function cPage(name,el){
  window.scrollTo(0,0);
  document.querySelectorAll('.c-page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.c-nav-link').forEach(n=>n.classList.remove('active'));
  const pg=document.getElementById('cpage-'+name);
  if(pg)pg.classList.add('active');
  if(el)el.classList.add('active');
  if(name==='cart')renderCart();
  if(name==='orders')renderOrders();
  if(name==='profile')renderAddrList();
    if(name==='profile')renderAddrList();
  if(name==='wishlist'){
    document.getElementById('wishlist-body').innerHTML = '<div style="padding:60px 0;text-align:center;color:var(--v-muted)">Loading your wishlist...</div>';
    renderWishlist();
  }
  if(name==='stats'){setTimeout(renderStats,80);}

}
function buildShop(){
  const cats=['All',...new Set(PRODUCTS.map(p=>p.cat))];
  document.getElementById('cat-row').innerHTML=cats.map(c=>
    `<div class="cat-strip-item${c==='All'?' on':''}" data-cat="${c}" onclick="setCat('${c}',this)">${catEmoji(c)} ${c}</div>`
  ).join('');
  renderProducts();
}

function catEmoji(c){
  const m={'All':'🏪','Hair Care':'💇','Alcohol':'🧴','Body Care':'🌺','Personal Care':'🌸'};
  return m[c]||'✨';
}

function setCat(c,el){
  activeCat=c;
  document.querySelectorAll('.cat-strip-item').forEach(x=>x.classList.remove('on'));
  el.classList.add('on');
  document.getElementById('section-title').textContent=c==='All'?'All Products':c;
  renderProducts();
}

function setCatAll(){
  activeCat='All';
  document.querySelectorAll('.cat-strip-item').forEach(x=>x.classList.remove('on'));
  document.querySelector('[data-cat="All"]').classList.add('on');
  document.getElementById('section-title').textContent='All Products';
  renderProducts();
}

function updatePriceDisplay(){
  const v=document.getElementById('filter-price-max').value;
  document.getElementById('price-display-val').textContent='₱'+parseInt(v).toLocaleString();
}
function clearFilters(){
  document.getElementById('filter-price-max').value=1000;
  document.getElementById('price-display-val').textContent='₱1,000';
  document.querySelectorAll('input[name="rating-filter"]')[0].checked=true;
  renderProducts();
}
function renderProducts(){
  const q=(document.getElementById('search-inp').value||'').toLowerCase();
  const priceMax=parseFloat(document.getElementById('filter-price-max')?.value||1000);
  const minRating=parseFloat(document.querySelector('input[name="rating-filter"]:checked')?.value||0);
  const list=PRODUCTS.filter(p=>{
    if(activeCat!=='All'&&p.cat!==activeCat)return false;
    if(q&&!p.name.toLowerCase().includes(q)&&!p.desc.toLowerCase().includes(q))return false;
    if(effPrice(p)>priceMax)return false;
    const r=productRatings[p.id];
    if(minRating>0&&(!r||parseFloat(r.avg)<minRating))return false;
    return true;
  });
  const grid=document.getElementById('products-grid');
  if(!list.length){grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:64px;color:var(--muted)"><div style="font-size:44px;margin-bottom:12px">🔍</div><p>No products found.</p></div>';return;}
  grid.innerHTML=list.map(p=>{
    const isLow=p.stock<30&&p.stock>0;
    const badge=saleActive(p)?'<span class="p-badge" style="background:#D4A853">⚡ Sale −'+salePct(p)+'%</span>':p.badge==='hot'?'<span class="p-badge">🔥 Hot</span>':p.badge==='new'?'<span class="p-badge new">✨ New</span>':'';
    const inWL=wishlist.includes(p.id);
    const r=productRatings[p.id];
    const starsHtml=r?[1,2,3,4,5].map(i=>`<span class="s${i<=Math.round(parseFloat(r.avg))?' on':''}" onclick="event.stopPropagation();rateProduct(${p.id},${i})">${i<=Math.round(parseFloat(r.avg))?'★':'☆'}</span>`).join('')+'<span class="p-rating-txt">('+r.count+')</span>':'';
    const expired=isExpired(p);
    return `<div class="p-card${expired?' expired':''}" onclick="openProductModal(${p.id})">
      ${expired?'<span class="p-badge" style="background:#B91C1C">⛔ Expired</span>':badge}
      <div class="p-img">
        ${productImgHtml(p)}
        <button class="p-wishlist" onclick="event.stopPropagation();toggleWishlist(${p.id})">${inWL?'❤️':'♡'}</button>
      </div>
      <div class="p-info">
        ${r?`<div class="p-stars-row">${starsHtml}</div>`:''}
        <div class="p-name">${p.name}</div>
        <div class="p-cat">${p.cat}</div>
        <div class="p-price-row">
          <div class="p-price">${priceHtml(p)}</div>
        </div>
        <div class="p-stock ${isLow?'low':''}">${p.stock===0?'Out of stock':isLow?'⚠️ Only '+p.stock+' left':p.stock+' in stock'}</div>
        <button class="p-add" onclick="event.stopPropagation();addCart(${p.id})" ${p.stock===0||expired?'disabled':''}>
          ${expired?'Expired':p.stock===0?'Out of Stock':'🛒 Add to Cart'}
        </button>
      </div>
    </div>`;
  }).join('');
}

/* Expired products can't be sold. The backend enforces this too (orders.py), so
   the rule still holds if someone bypasses the page. */
function isExpired(p){ return expiryInfo(p).state==='expired'; }
function dropExpiredFromCart(){
  if(!PRODUCTS.length) return 0;                    // products didn't load: never touch the cart
  let expiredCount=0, changed=false;
  Object.keys(cart).forEach(id=>{
    const p=PRODUCTS.find(x=>x.id==id);
    if(!p){ delete cart[id]; delete cartFromWishlist[id]; changed=true; return; }  // product no longer exists
    if(isExpired(p)){ delete cart[id]; delete cartFromWishlist[id]; expiredCount++; changed=true; }
  });
  if(changed){ saveCartToStorage(); saveWlOrigin(); updatePill(); }
  if(expiredCount) showToast('⚠️ '+expiredCount+' expired item'+(expiredCount===1?' was':'s were')+' removed from your cart.');
  return expiredCount;
}

function addCart(id){
  const p=PRODUCTS.find(x=>x.id===id);
  if(p && isExpired(p)){ showToast('⛔ '+p.name+' has expired and can no longer be ordered.'); return; }
  cart[id]=(cart[id]||0)+1;
  saveCartToStorage();
  updatePill();
  showToast('✅ '+p.name+' added to cart!');
}
async function toggleWishlist(id){
  try {
    const res = await apiFetch('/wishlist/'+id, { method: 'POST' });
    const idx=wishlist.indexOf(id);
    if(res.in_wishlist){ if(idx===-1)wishlist.push(id); showToast('❤️ Added to wishlist!'); }
    else{ if(idx>-1)wishlist.splice(idx,1); showToast('Removed from wishlist'); }
  } catch(e){ showToast('⚠️ '+e.message); return; }
  updateWishlistBadge();
  renderProducts();
}
/* Wishlist page: "Add to Cart" moves the item into the cart and takes it off the wishlist. */
async function moveWishlistToCart(id){
  const p=PRODUCTS.find(x=>x.id===id);
  if(!p) return;
  if(isExpired(p)){ showToast('⛔ '+p.name+' has expired and can no longer be ordered.'); return; }
  addCart(id);
  if(wishlist.includes(id)){
    try {
      let res=await apiFetch('/wishlist/'+id,{ method:'POST' });      // the server toggles: this removes it
      if(res.in_wishlist) res=await apiFetch('/wishlist/'+id,{ method:'POST' });   // page was out of sync: toggle back off
      const idx=wishlist.indexOf(id);
      if(idx>-1) wishlist.splice(idx,1);
      cartFromWishlist[id]=true; saveWlOrigin();      // remembered: removing it from the cart sends it back
      showToast('✅ '+p.name+' moved to your cart.');
    } catch(e){ showToast('⚠️ Added to cart, but could not remove it from your wishlist: '+e.message); }
  }
  updateWishlistBadge();
  renderWishlist();
  renderProducts();
}
function updateWishlistBadge(){
  const b=document.getElementById('wl-badge');
  if(!b)return;
  if(wishlist.length>0){b.textContent=wishlist.length;b.classList.add('on');}
  else{b.classList.remove('on');}
}
function renderWishlist(){
  const body=document.getElementById('wishlist-body');
  if(!wishlist.length){
    body.innerHTML=`<div class="empty-state">
      <div class="empty-icon">❤️</div>
      <h3>Your wishlist is empty</h3>
      <p>Save products you love by tapping the <b style="color:var(--rose)">♡ heart icon</b> on any product card in the Shop. They'll appear here so you can buy them later!</p>
      <button onclick="cPage('shop',document.getElementById('cnav-shop'))">Browse Products →</button>
      <div style="margin-top:22px;background:var(--rose-lt);border:1px solid var(--rose-mid);border-radius:12px;padding:14px 18px;max-width:340px;margin-left:auto;margin-right:auto;text-align:left">
        <div style="font-size:12px;font-weight:600;color:var(--rose-dk);margin-bottom:8px">💡 How to use Wishlist</div>
        <div style="font-size:12px;color:var(--text);line-height:1.7">
          1. Go to <b>Shop</b> and hover over a product<br>
          2. Click the <b>♡</b> heart button on the card<br>
          3. Come back here to view saved items<br>
          4. Add them to cart whenever you're ready!
        </div>
      </div>
    </div>`;
    return;
  }
  body.innerHTML=`<div class="wishlist-grid">${wishlist.map(id=>{
    const p=PRODUCTS.find(x=>x.id===id);if(!p)return'';
    const expired=isExpired(p);
    return`<div class="p-card${expired?' expired':''}" style="position:relative" onclick="openProductModal(${p.id})">
      <button class="wl-remove" onclick="event.stopPropagation();toggleWishlist(${p.id});renderWishlist()">✕</button>
      <div class="p-img">${productImgHtml(p)}</div>
      <div class="p-info">
        <div class="p-name">${p.name}</div>
        <div class="p-cat">${p.cat}</div>
        <div class="p-price-row"><div class="p-price">${priceHtml(p)}</div></div>
        <div class="p-stock ${p.stock===0?'low':''}">${p.stock===0?'Out of stock':p.stock+' in stock'}</div>
        <button class="p-add" onclick="event.stopPropagation();moveWishlistToCart(${p.id})" ${p.stock===0||expired?'disabled':''}>${expired?'Expired':'🛒 Add to Cart'}</button>
      </div>
    </div>`;
  }).join('')}</div>`;
}
async function rateProduct(id,rating,silent){
  let res;
  try {
    res = await apiFetch('/products/'+id+'/rate', { method: 'POST', body: JSON.stringify({ stars: rating }) });
  } catch(e) { if(!silent) showToast('⚠️ '+e.message); return; }
  productRatings[id] = { avg: res.avg.toFixed(1), count: res.count, userRating: res.user_rating };
  if(!silent) showToast('⭐ Rated '+rating+' star'+(rating>1?'s':'')+'!');
  renderProducts();
}

/* ═══════════════════════════════════════════
   DELIVERY CONFIRMATION (proof-of-delivery photo)
   Customer snaps a photo when their package arrives → order flips to
   "Delivered" and the admin gets notified, unlocking the rating prompt.
   We try the real backend endpoint first (POST /orders/:id/delivery-photo).
   If that route doesn't exist on the server yet, everything falls back to
   localStorage so the feature still works end-to-end for testing — once the
   backend adds the matching endpoint, this will start persisting properly
   across devices with no frontend changes needed.
═══════════════════════════════════════════ */
function loadDeliveryPhotos(){
  try { return JSON.parse(localStorage.getItem('gvci_delivery_photos')||'{}'); } catch(e){ return {}; }
}
function saveDeliveryPhotos(obj){
  try { localStorage.setItem('gvci_delivery_photos', JSON.stringify(obj)); } catch(e){}
}
function loadAdminNotifs(){
  try { return JSON.parse(localStorage.getItem('gvci_admin_notifs')||'[]'); } catch(e){ return []; }
}
function saveAdminNotifs(arr){
  try { localStorage.setItem('gvci_admin_notifs', JSON.stringify(arr)); } catch(e){}
}

/* Opens the device camera (or file picker) for a given order */
function openDeliveryCapture(orderId){
  const input=document.getElementById('delivery-photo-input');
  if(!input)return;
  input.dataset.orderId=orderId;
  input.value='';
  input.click();
}

function handleDeliveryPhotoInput(e){
  const file=e.target.files && e.target.files[0];
  const orderId=e.target.dataset.orderId;
  if(!file||!orderId)return;
  const reader=new FileReader();
  reader.onload=()=>confirmDelivery(orderId, reader.result);
  reader.readAsDataURL(file);
}

async function confirmDelivery(orderId, photoDataUrl){
  const order=myOrders.find(o=>o.id===orderId);
  if(!order)return;
  showToast('📤 Uploading delivery photo...');

  try {
    await apiFetch('/orders/'+order.dbId+'/delivery-photo', { method:'POST', body: JSON.stringify({ photo: photoDataUrl }) });
  } catch(e){ /* backend route not available yet — local fallback below still confirms delivery */ }

  order.status='Delivered';
  order.deliveryPhoto=photoDataUrl;

  const photos=loadDeliveryPhotos();
  photos[orderId]={ photo:photoDataUrl, customer:displayName||'Customer', time:new Date().toISOString(), items:order.items, total:order.total };
  saveDeliveryPhotos(photos);

  const notifs=loadAdminNotifs();
  notifs.unshift({ id:Date.now(), orderId, customer:displayName||'Customer', time:new Date().toISOString(), read:false });
  saveAdminNotifs(notifs);

  showToast('✅ Delivery confirmed! Our team has been notified.');
  renderOrders();
}

/* Full-size photo viewer modal (used by the admin to review proof-of-delivery photos) */
function viewDeliveryPhoto(orderId){
  const photos=loadDeliveryPhotos();
  const p=photos[orderId];
  const body=document.getElementById('photo-modal-body');
  if(!body)return;
  if(!p){ body.innerHTML='<div style="padding:40px;text-align:center;color:var(--muted)">No photo found for this order.</div>'; }
  else {
    body.innerHTML=`
      <img src="${p.photo}" alt="Delivery photo for ${orderId}" style="width:100%;max-height:60vh;object-fit:contain;background:#000;border-radius:8px 8px 0 0">
      <div style="padding:16px 20px">
        <div style="font-weight:600;color:var(--dark);margin-bottom:4px">Order ${orderId}</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:2px">Submitted by ${p.customer}</div>
        <div style="font-size:12px;color:var(--muted)">${new Date(p.time).toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
      </div>`;
  }
  document.getElementById('photo-modal-bg').classList.add('open');
}
function closePhotoModal(e){
  if(e && e.target && e.target.id !== 'photo-modal-bg' && e.type === 'click' && e.target.closest('#photo-modal')) return;
  document.getElementById('photo-modal-bg').classList.remove('open');
}

/* ═══ ADMIN: delivery-confirmation notifications ═══ */
function refreshAdminNotifBadge(){
  const notifs=loadAdminNotifs();
  const unread=notifs.filter(n=>!n.read).length;
  const dot=document.getElementById('admin-notif-dot');
  if(!dot)return;
  if(unread>0){dot.textContent=unread;dot.classList.add('on');}
  else{dot.classList.remove('on');}
}
function renderAdminNotifList(){
  const el=document.getElementById('admin-notif-list');
  if(!el)return;
  const notifs=loadAdminNotifs();
  if(!notifs.length){el.innerHTML='<div class="notif-empty">No delivery confirmations yet</div>';return;}
  el.innerHTML=notifs.map(n=>`
    <div class="notif-item ${n.read?'':'unread'}" style="cursor:pointer" onclick="openAdminNotif(${n.id})">
      <div class="ni-icon delivered"></div>
      <div class="ni-body">
        <div class="ni-title">Delivery confirmed — ${n.orderId}</div>
        <div class="ni-msg">${n.customer} uploaded a delivery photo</div>
        <div class="ni-time">${new Date(n.time).toLocaleString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
      </div>
      ${!n.read?'<div class="ni-unread-dot"></div>':''}
    </div>`).join('');
}
function toggleAdminNotifPanel(e){
  e.stopPropagation();
  const panel=document.getElementById('admin-notif-panel');
  panel.classList.toggle('open');
  if(panel.classList.contains('open')){ renderAdminNotifList(); refreshAdminNotifBadge(); }
}
function markAllAdminNotifsRead(){
  const notifs=loadAdminNotifs().map(n=>({...n,read:true}));
  saveAdminNotifs(notifs);
  renderAdminNotifList();refreshAdminNotifBadge();
}
function openAdminNotif(id){
  const notifs=loadAdminNotifs();
  const n=notifs.find(x=>x.id===id);
  if(!n)return;
  n.read=true;saveAdminNotifs(notifs);
  refreshAdminNotifBadge();renderAdminNotifList();
  const panel=document.getElementById('admin-notif-panel');
  if(panel)panel.classList.remove('open');
  aPanel('orders', document.getElementById('a-item-orders'));
  setTimeout(()=>viewDeliveryPhoto(n.orderId), 150);
}
document.addEventListener('click',function(e){
  const panel=document.getElementById('admin-notif-panel');
  if(panel&&panel.classList.contains('open')&&!panel.contains(e.target)&&!e.target.closest('.notif-bell')){panel.classList.remove('open');}
});
function buildRecommendations(){
  const wrap=document.getElementById('reco-wrap');
  if(!wrap)return;
  let reco=[];
  if(myOrders.length>0){
    // find cats from orders
    const orderedCats=new Set();
    myOrders.forEach(o=>{
      const itemNames=o.items.split(',');
      itemNames.forEach(nm=>{
        const p=PRODUCTS.find(x=>x.name===nm.trim());
        if(p)orderedCats.add(p.cat);
      });
    });
    reco=PRODUCTS.filter(p=>!isExpired(p)&&orderedCats.has(p.cat)&&!Object.keys(cart).map(Number).includes(p.id)).slice(0,8);
  }
  if(reco.length<4)reco=PRODUCTS.filter(p=>!isExpired(p)&&(p.badge==='hot'||p.badge==='new')).slice(0,8);
  if(!reco.length){wrap.style.display='none';return;}
  wrap.style.display='block';
  document.getElementById('reco-strip').innerHTML=reco.map(p=>`
    <div class="reco-card">
      <div class="reco-emoji">${productImgHtml(p, 36)}</div>
      <div class="reco-name">${p.name}</div>
      <div class="reco-price">${priceHtml(p)}</div>
      <button class="reco-btn" onclick="addCart(${p.id})">🛒 Add to Cart</button>
    </div>`).join('');
}
function toggleLoyaltyPanel(e){
  e.stopPropagation();
  const panel=document.getElementById('loyalty-panel');
  panel.classList.toggle('open');
}
document.addEventListener('click',function(e2){
  const lp=document.getElementById('loyalty-panel');
  if(lp&&lp.classList.contains('open')&&!lp.contains(e2.target)&&!e2.target.closest('.loyalty-pill'))lp.classList.remove('open');
});
function updateLoyaltyDisplay(){
  const totalSpent=myOrders.reduce((s,o)=>s+o.total,0);
  document.getElementById('lp-display').textContent=loyaltyPoints;
  document.getElementById('lp-pts-big').textContent=loyaltyPoints;
  document.getElementById('lp-spent').textContent='₱'+totalSpent.toLocaleString();
  document.getElementById('lp-orders').textContent=myOrders.length;
  document.getElementById('lp-pts-lbl2').textContent=loyaltyPoints+' pts';
  const pct=Math.min(loyaltyPoints/500*100,100);
  document.getElementById('lp-bar').style.width=pct+'%';
}
// Backwards-compatible alias (older markup may still call updateLoyalty(spent))
function updateLoyalty(){ updateLoyaltyDisplay(); }
/* Cart has no backend table — it only ever lived in memory, so a refresh
   wiped it. Persist it to localStorage per-user instead. */
function cartStorageKey(){
  return currentUser ? 'gvci_cart_'+currentUser.id : null;
}
function saveCartToStorage(){
  const key=cartStorageKey();
  if(!key) return;
  localStorage.setItem(key, JSON.stringify(cart));
}
function loadCartFromStorage(){
  const key=cartStorageKey();
  if(!key) return;
  try {
    const raw=localStorage.getItem(key);
    cart = raw ? JSON.parse(raw) : {};
  } catch(e){ cart={}; }
  loadWlOrigin();
  dropExpiredFromCart();
}
function clearCartStorage(){
  const key=cartStorageKey();
  if(key) localStorage.removeItem(key);
  // the cart was emptied for good (order placed), so nothing goes back to the wishlist
  cartFromWishlist={};
  const wk=wlOriginKey();
  if(wk) localStorage.removeItem(wk);
}

/* Items moved from the Wishlist into the cart. If one is later removed from the
   cart, it goes back onto the wishlist. Saved per user, like the cart. */
let cartFromWishlist={};
function wlOriginKey(){ return currentUser ? 'gvci_cart_wl_'+currentUser.id : null; }
function saveWlOrigin(){
  const k=wlOriginKey();
  if(k) localStorage.setItem(k, JSON.stringify(cartFromWishlist));
}
function loadWlOrigin(){
  const k=wlOriginKey();
  try {
    const raw=k?localStorage.getItem(k):null;
    cartFromWishlist = raw ? JSON.parse(raw) : {};
  } catch(e){ cartFromWishlist={}; }
  Object.keys(cartFromWishlist).forEach(id=>{ if(!cart[id]) delete cartFromWishlist[id]; });   // only items still in the cart
}

function updatePill(){
  document.getElementById('cart-pill').textContent='🛒 Cart ('+Object.values(cart).reduce((a,b)=>a+b,0)+')';
}

function renderCart(){
  dropExpiredFromCart();
  const body=document.getElementById('cart-body');
  const keys=Object.keys(cart);
  if(!keys.length){body.innerHTML=`<div class="empty-state"><div class="empty-icon">🛒</div><h3>Your cart is empty</h3><p>Browse our GV Cosmetics collection and add items you love.</p><button onclick="cPage('shop',document.getElementById('cnav-shop'))">Start Shopping →</button></div>`;return;}
  let total=0;
  body.innerHTML=keys.map(id=>{
    const p=PRODUCTS.find(x=>x.id==id);const sub=effPrice(p)*cart[id];total+=sub;
    return`<div class="cart-item">
      <div class="ci-img">${productImgHtml(p, 30)}</div>
      <div class="ci-info">
        <div class="ci-name">${p.name}</div>
        <div class="ci-price">${priceHtml(p)} each</div>
        <div class="ci-qty">
          <button class="qb" onclick="adjCart(${id},-1)">−</button>
          <span style="font-size:13px;font-weight:600;min-width:22px;text-align:center">${cart[id]}</span>
          <button class="qb" onclick="adjCart(${id},1)">+</button>
        </div>
      </div>
      <div class="ci-total">₱${sub.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
      <button onclick="delCart(${id})" style="background:none;border:none;color:var(--muted);cursor:pointer;font-size:22px;margin-left:12px;transition:color .15s" onmouseover="this.style.color='#c62828'" onmouseout="this.style.color='var(--muted)'">×</button>
    </div>`;
  }).join('');
  body.innerHTML+=`<div class="cart-footer">
    <div>
      <div style="font-size:13px;color:var(--muted)">Total</div>
      <div style="font-size:22px;font-weight:700;color:var(--rose);font-family:'Cormorant Garamond',serif">₱${total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
    </div>
    <button class="checkout-btn-main" onclick="openCheckout(${total})">Proceed to Checkout →</button>
  </div>`;
}
function adjCart(id,d){cart[id]=(cart[id]||0)+d;if(cart[id]<=0){delete cart[id];returnToWishlist(id);}saveCartToStorage();updatePill();renderCart();}
function delCart(id){delete cart[id];returnToWishlist(id);saveCartToStorage();updatePill();renderCart();}

/* An item that was moved from the wishlist and is then removed from the cart goes back to the wishlist. */
async function returnToWishlist(id){
  if(!cartFromWishlist[id]) return;                  // it didn't come from the wishlist: nothing to do
  delete cartFromWishlist[id]; saveWlOrigin();
  if(wishlist.includes(id)) return;                  // already back on the wishlist
  const p=PRODUCTS.find(x=>x.id===id);
  try {
    let res=await apiFetch('/wishlist/'+id,{ method:'POST' });                   // the server toggles: this adds it
    if(!res.in_wishlist) res=await apiFetch('/wishlist/'+id,{ method:'POST' });  // it was already there: toggle back on
    if(!wishlist.includes(id)) wishlist.push(id);
    showToast('❤️ '+(p?p.name:'Item')+' is back on your wishlist.');
  } catch(e){ showToast('⚠️ Removed from your cart, but could not put it back on your wishlist: '+e.message); }
  updateWishlistBadge();
  renderWishlist();
  renderProducts();
}

function openCheckout(grand){
  const defAddr=addresses.find(a=>a.isDefault)||addresses[0];
  const keys=Object.keys(cart);
  document.getElementById('checkout-body').innerHTML=`
    <div class="checkout-wrap">
      <h2>Checkout</h2>
      <div class="checkout-progress">
        <div class="cp-step"><div class="cp-circle done">✓</div><span class="cp-lbl done">Cart</span></div>
        <div class="cp-line done"></div>
        <div class="cp-step"><div class="cp-circle act">2</div><span class="cp-lbl act">Details</span></div>
        <div class="cp-line pend"></div>
        <div class="cp-step"><div class="cp-circle pend">3</div><span class="cp-lbl pend">Confirm</span></div>
      </div>
      <div class="order-summary-box">
        <div class="os-title">Order Summary</div>
        ${keys.map(id=>{const p=PRODUCTS.find(x=>x.id==id);return`<div class="os-row"><span>${p.name} × ${cart[id]}</span><span>${fmtPeso(effPrice(p)*cart[id])}</span></div>`;}).join('')}
        <div class="os-row os-total"><span>Total</span><span style="color:var(--rose)">₱${grand.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
      </div>
      <div class="form-2col">
        <div class="fg" id="fg-fn"><label>First Name *</label><input id="co-fn" value="${displayName.split(' ')[0]}"><div class="fg-err">First name is required.</div></div>
        <div class="fg" id="fg-ln"><label>Last Name *</label><input id="co-ln" value="${displayName.split(' ').slice(1).join(' ')}"><div class="fg-err">Last name is required.</div></div>
      </div>
      <div class="fg" id="fg-ph"><label>Phone *</label><input id="co-ph" inputmode="numeric" value="${defAddr?.phone||''}"><div class="fg-err">Phone number is required.</div></div>
      <div class="fg" id="fg-addr">
        <label>Delivery Address *</label>
        <select id="co-addr-select" onchange="onCheckoutAddressChange()">${buildCheckoutAddressOptions(defAddr?.id)}</select>
        <input type="hidden" id="co-addr">
        <input type="hidden" id="co-city">
        <input type="hidden" id="co-prov">
        ${addresses.length ? '' : `<div style="font-size:12px;margin-top:6px"><a href="#" onclick="cPage('profile',document.getElementById('cnav-profile'));return false;">+ Add a delivery address in your profile</a></div>`}
        <div class="fg-err">Please select a delivery address.</div>
      </div>
      <div class="fg"><label>Payment Method</label>
        <select id="co-pay"><option value="cod">Cash on Delivery</option><!-- Cashless options hidden for now (the cashless code is still in place). To bring them back, move these three lines out of this comment: <option value="gcash">GCash</option> <option value="card">Credit/Debit Card</option> <option value="maya">Maya</option> --></select>
      </div>
      <button class="place-btn" onclick="placeOrder(${grand})">Place Order — ₱${grand.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})} →</button>
    </div>`;
  // Clear a field's error state as soon as the customer starts fixing it
  ['co-fn','co-ln','co-ph'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('input',()=>clearFieldError(id));
  });
  attachLetterOnlyFields(['co-fn','co-ln']);
  attachDigitOnlyFields(['co-ph']);
  onCheckoutAddressChange(); // populate the hidden address/city/province fields from the default selection
  cPage('checkout',null);
}

/* Builds the <option> list for the checkout's saved-address dropdown */
function buildCheckoutAddressOptions(selectedId){
  if(!addresses.length){
    return `<option value="">No saved address yet</option>`;
  }
  return addresses.map(a=>{
    const label=(a.label?a.label+' — ':'')+streetWithBrgy(a.street,a.barangay)+', '+a.city+', '+a.province;
    const isSelected = selectedId!=null ? a.id===selectedId : a.isDefault;
    return `<option value="${a.id}" ${isSelected?'selected':''}>${label}</option>`;
  }).join('');
}

/* Fires when the customer picks a saved address from the checkout dropdown
   (and once on page load) — fills the hidden address/city/province fields
   and the phone number automatically, so nothing needs to be typed. */
function onCheckoutAddressChange(){
  const sel=document.getElementById('co-addr-select');
  const addrHidden=document.getElementById('co-addr');
  const cityHidden=document.getElementById('co-city');
  const provHidden=document.getElementById('co-prov');
  if(!sel||!addrHidden) return;
  const a=addresses.find(x=>String(x.id)===sel.value);
  if(a){
    addrHidden.value=streetWithBrgy(a.street,a.barangay);
    cityHidden.value=a.city;
    provHidden.value=a.province;
    const phInput=document.getElementById('co-ph');
    if(phInput && !phInput.value.trim() && a.phone) phInput.value=a.phone;
  } else {
    addrHidden.value=''; cityHidden.value=''; provHidden.value='';
  }
  clearFieldError('co-addr');
}

/* Maps a checkout input id to its wrapping .fg field id */
const CHECKOUT_FIELD_MAP={ 'co-fn':'fg-fn','co-ln':'fg-ln','co-ph':'fg-ph','co-addr':'fg-addr' };

function clearFieldError(inputId){
  const wrap=document.getElementById(CHECKOUT_FIELD_MAP[inputId]);
  if(wrap && document.getElementById(inputId).value.trim()) wrap.classList.remove('invalid');
}

/* Validates every required checkout field, highlights the empty ones,
   and returns true only when the whole form is filled in. */
function validateCheckoutForm(){
  let firstInvalid=null;
  let allValid=true;
  Object.keys(CHECKOUT_FIELD_MAP).forEach(inputId=>{
    const input=document.getElementById(inputId);
    const wrap=document.getElementById(CHECKOUT_FIELD_MAP[inputId]);
    if(!input||!wrap)return;
    const empty=!input.value.trim();
    wrap.classList.toggle('invalid',empty);
    if(empty){
      allValid=false;
      if(!firstInvalid)firstInvalid=input;
    }
  });
  if(firstInvalid){
    firstInvalid.focus();
    firstInvalid.scrollIntoView({behavior:'smooth',block:'center'});
  }
  return allValid;
}

async function placeOrder(grand){
  if(dropExpiredFromCart()){ cPage('cart',document.getElementById('cnav-cart')); renderCart(); return; }
  if(!validateCheckoutForm()){
    showToast('⚠️ Please fill in all required fields before placing your order.');
    return;
  }
  const fn=document.getElementById('co-fn').value.trim();
  const ln=document.getElementById('co-ln').value.trim();
  const ph=document.getElementById('co-ph').value.trim();
  const addr=document.getElementById('co-addr').value.trim();
  const city=document.getElementById('co-city').value.trim();
  const prov=document.getElementById('co-prov').value.trim();
  const addrFull=addr+', '+city+', '+prov;
  const payMethod=document.getElementById('co-pay').value;
  const items=Object.keys(cart).map(id=>({product_id:parseInt(id),quantity:cart[id]}));

  let order;
  try {
    order = await apiFetch('/orders', {
      method: 'POST',
      body: JSON.stringify({ items, shipping_name: (fn+' '+ln).trim(), shipping_address: addrFull })
    });
  } catch(e) {
    // Order was never created — cart is untouched, customer just stays on checkout.
    showToast('⚠️ '+e.message);
    return;
  }

  // Cash on Delivery needs no payment step — confirm immediately, same as before.
  if(payMethod==='cod'){
    await finishCheckoutSuccess(order, addrFull);
    return;
  }

  // GCash / Card / Maya: create the PayMongo checkout session and hand the
  // customer off to PayMongo's hosted payment page.
  let session;
  try {
    session = await apiFetch(`/orders/${order.id}/checkout-session`, {
      method: 'POST',
      body: JSON.stringify({ payment_method: payMethod })
    });
  } catch(e) {
    // Payment could not even start. Undo the order so it doesn't sit around
    // as an orphaned "pending" record, leave the cart exactly as it was
    // (it was never cleared), and send the customer back to their cart
    // instead of stranding them on a broken checkout page.
    try {
      await apiFetch('/orders/'+order.id+'/cancel', {
        method: 'POST',
        body: JSON.stringify({ reason: 'Payment session could not be created' })
      });
    } catch(e2) { /* best-effort cleanup — nothing more we can do here */ }
    showToast('⚠️ Could not start payment (' + e.message + '). Your items are still in your cart.');
    cPage('cart', document.getElementById('cnav-cart'));
    renderCart();
    return;
  }

  // Session created successfully — now it's safe to clear the cart and go pay.
  cart={};clearCartStorage();updatePill();
  window.location.href = session.checkout_url;
}

/* Shared "order confirmed" success flow (currently only reached by Cash on
   Delivery — GCash/Card/Maya orders finish on PayMongo's own success page). */
async function finishCheckoutSuccess(order, addrFull){
  cart={};clearCartStorage();updatePill();
  await loadProducts(); // stock changed
  try { const me = await apiFetch('/auth/me'); loyaltyPoints = me.loyalty_points; } catch(e){}
  myOrders.unshift(mapOrder(order));
  updateLoyaltyDisplay();
  buildRecommendations();

  document.getElementById('checkout-body').innerHTML=`
    <div class="success-wrap">
      <div class="success-icon">🎉</div>
      <h2>Order Placed!</h2>
      <p>Order <b style="color:var(--rose-dk)">${order.order_number}</b> is confirmed!<br>Delivering to:<br><b style="color:var(--rose)">${addrFull}</b><br><br>We'll notify you when your order status changes.</p>
      <button class="cont-btn" onclick="cPage('shop',document.getElementById('cnav-shop'))">Continue Shopping 💄</button>
    </div>`;
}

/* ═══ CANCEL ORDER (customer, Pending only) ═══ */
let CANCEL_ORDER_ID=null;
function openCancelModal(dbId){
  CANCEL_ORDER_ID=dbId;
  const sel=document.getElementById('cancel-reason-select');
  sel.value='Changed my mind';
  const other=document.getElementById('cancel-reason-other');
  other.value='';
  other.style.display='none';
  document.getElementById('cancel-modal-bg').classList.add('open');
}
function closeCancelModal(){
  document.getElementById('cancel-modal-bg').classList.remove('open');
  CANCEL_ORDER_ID=null;
}
function onCancelReasonChange(){
  const v=document.getElementById('cancel-reason-select').value;
  document.getElementById('cancel-reason-other').style.display = v==='Other' ? 'block' : 'none';
}
async function confirmCancelOrder(){
  if(!CANCEL_ORDER_ID) return;
  const sel=document.getElementById('cancel-reason-select').value;
  let reason=sel;
  if(sel==='Other'){
    const other=document.getElementById('cancel-reason-other').value.trim();
    if(!other){ showToast('Please tell us why.'); return; }
    reason=other;
  }
  const orderId=CANCEL_ORDER_ID;
  try {
    await apiFetch('/orders/'+orderId+'/cancel', { method:'POST', body: JSON.stringify({ reason }) });
    await loadOrders();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  closeCancelModal();
  renderOrders();
  showToast('Order cancelled.');
}

/* Cancelled/Delivered orders older than 2 days collapse into a compact
   summary row by default, so finished orders don't pile up on this page.
   Nothing is deleted — tapping "View Details" expands it right back. */
let expandedOrders = new Set();
function toggleOrderExpand(orderId){
  if(expandedOrders.has(orderId)) expandedOrders.delete(orderId);
  else expandedOrders.add(orderId);
  renderOrders();
}
function daysSinceOrder(isoDateStr){
  if(!isoDateStr) return 0;
  const then = new Date(isoDateStr).getTime();
  if(isNaN(then)) return 0;
  return (Date.now() - then) / 86400000;
}

function renderOrders(){
  const body=document.getElementById('orders-body');
  disposeInlineTracks();                       // the cards are about to be redrawn
  if(!myOrders.length){body.innerHTML=`<div class="empty-state"><div class="empty-icon">📦</div><h3>No orders yet</h3><p>Start shopping to see your orders here!</p><button onclick="cPage('shop',document.getElementById('cnav-shop'))">Shop Now →</button></div>`;return;}
  body.innerHTML=myOrders.map(o=>{
    const isSettled = o.status==='Cancelled' || o.status==='Delivered';
    const isOld = daysSinceOrder(o.createdAt) >= 2;
    const isCollapsed = isSettled && isOld && !expandedOrders.has(o.id);
    if(isCollapsed){
      return `<div class="order-card order-card-collapsed">
        <div class="oc-head"><span class="oc-id">${o.id}</span><span class="oc-date">${o.date}</span></div>
        <div class="oc-items" style="opacity:.7">${o.items}</div>
        <div class="oc-foot">
          <span class="oc-price">₱${o.total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
          <span class="badge ${o.status==='Delivered'?'bg-green':'bg-red'}">${statusLabel(o.status)}</span>
        </div>
        <button class="btn-cancel-order" style="width:100%;margin-top:10px;background:none;border:1px solid var(--rose,#C2607E);color:var(--rose,#C2607E)" onclick="toggleOrderExpand('${o.id}')">View Details</button>
      </div>`;
    }
    const steps=[
      {label:'Order Placed',sub:'Order received & confirmed',status:'done'},
      {label:'Processing',sub:o.packedAt?'Packed and ready for delivery':'Preparing your items',status:o.status==='Pending'?'pend':'done'},
      {label:'For Delivery',sub:'On its way to you',status:o.status==='Delivered'||o.status==='Shipped'?o.status==='Delivered'?'done':'act':'pend'},
      {label:'Delivered',sub:'Package delivered',status:o.status==='Delivered'?'done':'pend'},
    ];
    const deliveryPhotos=loadDeliveryPhotos();
    const hasPhoto=!!deliveryPhotos[o.id];
    const deliveryHtml=(o.status==='Shipped'&&!hasPhoto)?`
      <div class="delivery-confirm">
        <div class="dc-icon">📷</div>
        <div class="dc-body">
          <div class="dc-title">Received your package?</div>
          <div class="dc-sub">Take a quick photo to confirm delivery — this notifies our team.</div>
        </div>
        <button class="dc-btn" onclick="openDeliveryCapture('${o.id}')">Confirm Delivery</button>
      </div>`:(hasPhoto?`
      <div class="delivery-confirmed">
        <img src="${deliveryPhotos[o.id].photo}" class="dc-thumb" onclick="viewDeliveryPhoto('${o.id}')" alt="Delivery photo">
        <div class="dc-body"><div class="dc-title">✅ Delivery photo submitted</div><div class="dc-sub">Thanks! Our team has been notified.</div></div>
      </div>`:'');
    const trackHtml=o.tracking?`<div class="oc-tracking">
      <div class="oc-track-no">Tracking: <span>${o.tracking}</span></div>
      <div class="tt">${steps.map(s=>`<div class="tt-row"><div class="tt-dot ${s.status}">${s.status==='done'?'✓':s.status==='act'?'→':'○'}</div><div class="tt-body"><div class="tt-lbl">${s.label}</div><div class="tt-sub">${s.sub}</div></div></div>`).join('')}</div>
      ${deliveryHtml}
      ${o.status==='Delivered'?reviewBlockHtml(o):''}
    </div>`:(deliveryHtml?`<div class="oc-tracking">${deliveryHtml}</div>`:'')
    return`<div class="order-card">
      <div class="oc-head"><span class="oc-id">${o.id}</span><span class="oc-date">${o.date}</span></div>
      <div class="oc-items">${o.items}</div>
      ${o.address?`<div class="oc-addr">📍 ${o.address}</div>`:''}
      <div class="oc-foot">
        <span class="oc-price">₱${o.total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
        <span class="badge ${o.status==='Delivered'?'bg-green':o.status==='Shipped'?'bg-blue':o.status==='Processing'?'bg-amber':o.status==='Cancelled'?'bg-red':'bg-gray'}">${statusLabel(o.status)}</span>
      </div>
      ${o.status==='Processing'&&o.packedAt?`<div class="oc-addr" style="color:#166534;font-weight:600">📦 Packed — your order is ready for delivery</div>`:''}
      ${o.status==='Shipped'?`<div class="itrack" data-itrack="${o.dbId}">
        <div class="itrack-title">📍 Where is my order?</div>
        <div class="itrack-status">Looking for your rider…</div>
        <div class="itrack-map"></div>
        <button class="itrack-bigger" onclick="openTrackModal(${o.dbId},'${o.id}')">🔍 Open larger map</button>
      </div>`:''}
      ${o.status==='Pending'?`<button class="btn-cancel-order" style="width:100%;margin-top:10px" onclick="openCancelModal(${o.dbId})">Cancel Order</button>`:''}
      ${o.status==='Cancelled'&&o.cancelReason?`<div class="oc-addr" style="color:var(--red,#DC2626)">✕ Cancelled: ${o.cancelReason}</div>`:''}
      ${trackHtml}
      ${isSettled&&isOld?`<button class="btn-cancel-order" style="width:100%;margin-top:10px;background:none;border:1px solid var(--muted,#8A8580);color:var(--muted,#8A8580)" onclick="toggleOrderExpand('${o.id}')">▲ Minimize</button>`:''}
    </div>`;
  }).join('');
  initInlineTracks();                          // live map in every For Delivery card
}

/* ═══ PROFILE ═══ */
function renderAddrList(){
  document.getElementById('addr-list').innerHTML=addresses.map((a,i)=>`
    <div class="addr-card" style="position:relative">
      <button class="addr-delete-btn" onclick="deleteAddress(${a.id})" style="position:absolute;top:10px;right:10px;background:none;border:none;font-size:16px;color:var(--muted);cursor:pointer">✕</button>
      ${a.isDefault?'<span class="addr-default" style="position:absolute;top:38px;right:10px">Default</span>':`<button class="addr-setdefault-btn" style="position:absolute;top:10px;right:34px" onclick="setDefaultAddress(${a.id})">Set as Default</button>`}
      <p>${a.name} · ${a.phone}</p>
      <span>${streetWithBrgy(a.street,a.barangay)}<br>${a.city}, ${a.province} ${a.zip} · ${a.label}</span>
    </div>`).join('');

}

async function setDefaultAddress(id){
  try {
    await apiFetch('/addresses/'+id+'/default', { method:'PATCH' });
    await loadAddresses();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  renderAddrList();
  showToast('✅ Default address updated!');
}

async function deleteAddress(id){
  if(!confirm('Delete this address?')) return;
  try {
    await apiFetch('/addresses/'+id, { method:'DELETE' });
    await loadAddresses();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  renderAddrList();
  showToast('🗑 Address deleted.');
}
async function addAddress(){
  const name=document.getElementById('addr-name').value.trim();
  const street=document.getElementById('addr-street').value.trim();
  if(!name||!street){showToast('Please fill in the required fields.');return;}
  const barangay=(document.getElementById('addr-barangay')?.value||'').trim();
  if(!document.getElementById('addr-city').value){showToast('Please select a city.');return;}
  if(!barangay){showToast('Please select a barangay.');return;}
  const payload={name,phone:document.getElementById('addr-phone').value,street,barangay,city:document.getElementById('addr-city').value,province:document.getElementById('addr-province').value,zip:document.getElementById('addr-zip').value,label:document.getElementById('addr-label').value,is_default:addresses.length===0};
  try {
    await apiFetch('/addresses', { method:'POST', body: JSON.stringify(payload) });
    await loadAddresses();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  renderAddrList();showToast('✅ Address added!');
}
function savePersonalInfo(){
  const fname = document.getElementById('pf-fname').value.trim();
  const lname = document.getElementById('pf-lname').value.trim();
  displayName = (fname+' '+lname).trim();

  document.getElementById('prof-display-name').textContent = displayName;
  document.getElementById('c-username').textContent = fname;

  const initials = ((fname[0]||'') + (lname[0]||'')).toUpperCase();
  document.getElementById('c-avatar').textContent = initials;
  document.getElementById('prof-avatar-big').textContent = initials;
  if(currentUser){ currentUser.name = displayName; currentUser.initials = initials; }

  showToast('✅ Profile updated!');

}
function checkStrength(){
  const v=document.getElementById('pwd-new').value;
  const bar=document.getElementById('pwd-strength');const lbl=document.getElementById('pwd-strength-label');
  const pct=Math.min(v.length/10*100,100);
  const color=pct<40?'#C87941':pct<70?'#D97706':'#16A34A';
  const text=pct<40?'Weak':pct<70?'Moderate':'Strong';
  bar.style.width=pct+'%';bar.style.background=color;lbl.textContent=text;lbl.style.color=color;
}
async function changePassword(){
  const cur=document.getElementById('pwd-current').value;
  const nw=document.getElementById('pwd-new').value;
  const cf=document.getElementById('pwd-confirm').value;
  if(nw.length<6){showToast('❌ New password must be at least 6 characters.');return;}
  if(nw!==cf){showToast('❌ Passwords do not match.');return;}
  try {
    await apiFetch('/auth/change-password', { method:'POST', body: JSON.stringify({ current_password: cur, new_password: nw }) });
  } catch(e){ showToast('❌ '+e.message); return; }
  currentPass=nw;
  document.getElementById('pwd-current').value='';document.getElementById('pwd-new').value='';document.getElementById('pwd-confirm').value='';
  showToast('✅ Password updated successfully!');
}

/* ═══════════════════════════════════════════
   ADMIN
═══════════════════════════════════════════ */

/* ═══ LIVE SALES DATA ═══
   Every chart below is calculated from the real orders loaded from the server
   (Cancelled orders don't count). Nothing here is sample data, so a new customer
   order shows up automatically the next time the admin data refreshes. */
function fmtPeso(n){
  return '₱'+(Number(n)||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
}

/* Top products: Weekly = last 7 days, Monthly = last 30 days, Yearly = last 365 days */
const TOP_PERIOD_DAYS={week:7,month:30,year:365};
const TOP_PERIOD_TEXT={week:'Last 7 days',month:'Last 30 days',year:'Last 365 days'};

function computeTopProducts(period){
  const since=new Date(); since.setHours(0,0,0,0);
  since.setDate(since.getDate()-(TOP_PERIOD_DAYS[period]-1));
  const map=new Map();
  revenueOrders().forEach(o=>{
    if(o.date<since) return;
    o.lines.forEach(l=>{
      const key=l.productId!=null?'id:'+l.productId:'name:'+l.name;
      const p=PRODUCTS.find(x=>x.id===l.productId)||PRODUCTS.find(x=>x.name===l.name);
      let r=map.get(key);
      if(!r){ r={name:p?p.name:l.name,cat:p?p.cat:'—',units:0,revenue:0}; map.set(key,r); }
      r.units+=l.qty;
      r.revenue+=l.qty*l.price;
    });
  });
  const rows=[...map.values()];
  rows.forEach(r=>{ r.revenue=Math.round(r.revenue*100)/100; });
  // Moving speed is relative to the best seller in the same period
  const best=Math.max(0,...rows.map(r=>r.units));
  rows.forEach(r=>{ r.status = r.units>=best*0.5 ? 'Fast Moving' : r.units>=best*0.2 ? 'Moderate' : 'Slow Moving'; });
  return rows;
}
function topNote(period,rows){
  const lbl=TOP_PERIOD_TEXT[period];
  if(!rows.length) return lbl+' · no sales yet';
  const units=rows.reduce((s,r)=>s+r.units,0), rev=rows.reduce((s,r)=>s+r.revenue,0);
  return `${lbl} · ${units} unit${units===1?'':'s'} · ${fmtPeso(rev)}`;
}

const PERIOD_LABELS={week:'Weekly',month:'Monthly',year:'Yearly'};
let anTopChart=null, anTopPeriod='month', anTopMetric='units';
let dbTopChart=null, dbTopPeriod='month', dbTopMetric='units';

/* ═══ CSV EXPORT (generic helper — used by every "Export CSV" button) ═══ */
function downloadCSV(filename, headers, rows){
  const esc = (v) => {
    const s = String(v==null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const lines = [headers.map(esc).join(',')].concat(rows.map(r => r.map(esc).join(',')));
  const csv = lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportOrdersCSV(){
  if(!ORDERS_DATA.length){ showToast('No orders to export.'); return; }
  const rows = ORDERS_DATA.map(o => [o.id, o.customer, o.items, o.total, o.date, o.status]);
  downloadCSV('gv-cosmetics-orders.csv', ['Order ID','Customer','Items','Total','Date','Status'], rows);
  showToast('✅ Orders exported.');
}

function exportCustomersCSV(){
  if(!CUSTOMERS_DATA.length){ showToast('No customers to export.'); return; }
  const rows = CUSTOMERS_DATA.map(c => [c.name, c.email, c.orders, c.total, c.seg]);
  downloadCSV('gv-cosmetics-customers.csv', ['Name','Email','Total Orders','Total Spent','Segment'], rows);
  showToast('✅ Customer list exported.');
}

function exportInventoryCSV(){
  if(!PRODUCTS.length){ showToast('No products to export.'); return; }
  const rows = PRODUCTS.map(p => [p.name, p.cat, p.stock, p.stock===0?'Out of Stock':p.stock<30?'Low Stock':'In Stock', p.mfg||'', p.exp||'', expiryStatusText(p)]);
  downloadCSV('gv-cosmetics-inventory.csv', ['Product','Category','Current Stock','Status','Manufacturing Date','Expiry Date','Expiry Status'], rows);
  showToast('✅ Inventory report exported.');
}

function exportTopProductsCSV(){
  const data = getTopProductsSorted(anTopPeriod, anTopMetric);
  if(!data.length){ showToast('No sales in this period to export yet.'); return; }
  const rows = data.map(r => [r.name, r.cat, r.units, r.revenue, r.status]);
  downloadCSV(`gv-cosmetics-top-products-${anTopPeriod}.csv`, ['Product','Category','Units Sold','Revenue','Status'], rows);
  showToast('✅ Report exported.');
}

function getTopProductsSorted(period,metric){
  return computeTopProducts(period).sort((a,b)=>metric==='revenue'?b.revenue-a.revenue:b.units-a.units);
}

function statusBadge(status){
  return `<span class="badge ${status==='Fast Moving'?'bg-green':status==='Moderate'?'bg-amber':'bg-red'}">${status}</span>`;
}

/* Renders the Top Products chart shared by Dashboard + Analytics.
   target = {canvasId, period, metric, limit} */
function renderTopProductsChart(canvasId,period,metric,limit){
  const ctx=document.getElementById(canvasId);
  if(!ctx) return null;
  const rows=getTopProductsSorted(period,metric).slice(0,limit||5);
  return new Chart(ctx,{type:'bar',data:{labels:rows.map(r=>r.name.length>18?r.name.slice(0,16)+'…':r.name),
    datasets:[{data:rows.map(r=>metric==='revenue'?r.revenue:r.units),backgroundColor:'rgba(194,96,126,0.8)',borderRadius:6,label:metric==='revenue'?'₱':'Units'}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{y:{beginAtZero:true,suggestedMax:rows.length?undefined:10,grid:{color:'#F1F5F9'},ticks:{precision:0,callback:v=>metric==='revenue'?'₱'+v.toLocaleString():v}}}}});
}

/* DASHBOARD: Top Products card (period only — always ranked by units) */
function renderDbTopChart(){
  if(dbTopChart) dbTopChart.destroy();
  dbTopChart=renderTopProductsChart('ch-db-top',dbTopPeriod,dbTopMetric,5);
  const note=document.getElementById('db-top-note');
  if(note) note.textContent=topNote(dbTopPeriod,computeTopProducts(dbTopPeriod));
}
function onDbTopChange(){
  dbTopPeriod=document.getElementById('db-top-period').value;
  dbTopMetric=document.getElementById('db-top-metric').value;
  renderDbTopChart();
}

/* ANALYTICS: Top Products chart + Product Performance Report table */
function renderAnTopChart(){
  if(anTopChart) anTopChart.destroy();
  anTopChart=renderTopProductsChart('ch-prod',anTopPeriod,anTopMetric,5);
  const note=document.getElementById('an-top-note');
  if(note) note.textContent=topNote(anTopPeriod,computeTopProducts(anTopPeriod));
}
function renderAnTopTable(){
  const tbody=document.getElementById('an-top-tbody');
  if(!tbody) return;
  const rows=getTopProductsSorted(anTopPeriod,anTopMetric).slice(0,10);
  tbody.innerHTML=rows.length ? rows.map(r=>
    `<tr><td>${r.name}</td><td>${r.cat}</td><td>${r.units}</td><td>${fmtPeso(r.revenue)}</td><td>${statusBadge(r.status)}</td></tr>`
  ).join('') : `<tr><td colspan="5" style="text-align:center;padding:24px;color:#64748B">No sales in the ${TOP_PERIOD_TEXT[anTopPeriod].toLowerCase()} yet.</td></tr>`;
  const lbl=document.getElementById('an-top-period-label');
  if(lbl) lbl.textContent=PERIOD_LABELS[anTopPeriod];
}
function onAnTopChange(){
  anTopPeriod=document.getElementById('an-top-period').value;
  anTopMetric=document.getElementById('an-top-metric').value;
  renderAnTopChart();
  renderAnTopTable();
}

/* DASHBOARD: Weekly Sales Revenue (Mon-Sun) from real orders */
const WEEK_DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
let dbWeekOffset=0, dbWeekChart=null;
function weekStart(offset){
  const d=new Date(); d.setHours(0,0,0,0);
  d.setDate(d.getDate()-((d.getDay()+6)%7)+offset*7);   // Monday of the chosen week
  return d;
}
function renderDbWeeklyChart(){
  const canvas=document.getElementById('ch-sales');
  if(!canvas) return;
  const start=weekStart(dbWeekOffset), end=new Date(start); end.setDate(end.getDate()+7);
  const data=Array(7).fill(0); let total=0, count=0;
  revenueOrders().forEach(o=>{
    if(o.date>=start && o.date<end){ data[(o.date.getDay()+6)%7]+=o.total; total+=o.total; count++; }
  });
  const today=new Date(); today.setHours(0,0,0,0);
  const labels=WEEK_DAYS.map((nm,i)=>{
    const d=new Date(start); d.setDate(start.getDate()+i);
    if(d>today) data[i]=null;                              // days that haven't happened yet stay empty
    return nm+' '+d.getDate();
  });
  const last=new Date(start); last.setDate(last.getDate()+6);
  const fmt=d=>d.toLocaleDateString('en-PH',{month:'short',day:'numeric'});
  const sum=document.getElementById('db-week-sum');
  if(sum) sum.textContent=`${fmt(start)} – ${fmt(last)} · ${fmtPeso(total)} · ${count} order${count===1?'':'s'}`;
  if(dbWeekChart) dbWeekChart.destroy();
  dbWeekChart=new Chart(canvas,{type:'bar',
    data:{labels,datasets:[{data,backgroundColor:'rgba(79,126,247,0.85)',borderRadius:6,label:'Revenue'}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>fmtPeso(c.parsed.y)}}},
      scales:{y:{beginAtZero:true,suggestedMax:total>0?undefined:100,ticks:{callback:v=>'₱'+v.toLocaleString()},grid:{color:'#F1F5F9'}}}}});
}
function onDbWeekChange(){
  dbWeekOffset=parseInt(document.getElementById('db-week-sel').value)||0;
  renderDbWeeklyChart();
}

/* Keeps the admin charts current: a cheap fingerprint of the loaded data, so the
   screen only rebuilds when something actually changed (new order, status change...) */
let lastAdminSig='';
function adminDataSignature(){
  return ORDERS_DATA.map(o=>o.id+':'+o.status+':'+o.total+':'+(o.packedAt?1:0)).join('|')
    +'#'+PRODUCTS.length+':'+PRODUCTS.reduce((s,p)=>s+p.stock,0)+'#'+CUSTOMERS_DATA.length;
}
async function refreshAdminData(name){
  const before=adminDataSignature();
  try{
    if(name==='dashboard'||name==='analytics') await Promise.all([loadOrders(),loadProducts(),loadCustomers()]);
    else if(name==='orders'||name==='packing') await loadOrders();
    else return false;
  }catch(e){ return false; }
  return adminDataSignature()!==before;
}
// While the admin is looking at the Dashboard or Analytics, check for new orders every minute
setInterval(async()=>{
  if(!currentUser||currentUser.role!=='admin'||document.hidden) return;
  const panel=document.querySelector('.a-panel.on');
  const name=panel?panel.id.replace('ap-',''):'';
  const rebuild={dashboard:buildDashboard,analytics:buildAnalytics,packing:buildPacking,orders:buildOrders}[name];
  if(!rebuild) return;                       // other panels have forms/dropdowns, so they aren't redrawn on a timer
  if(await refreshAdminData(name)) rebuild();
},60000);

function aPanel(name,el){
  document.querySelectorAll('.a-panel').forEach(p=>p.classList.remove('on'));
  document.querySelectorAll('.a-item').forEach(n=>n.classList.remove('on'));
  document.getElementById('ap-'+name).classList.add('on');
  el.classList.add('on');
  const builders={dashboard:buildDashboard,analytics:buildAnalytics,products:buildProducts,orders:buildOrders,customers:buildCustomers,approvals:buildApprovals,inventory:buildInventory,packing:buildPacking,deliveries:buildDeliveries};
  // Opening a panel starts from the default view (Monthly, This Week, ...)
  if(name==='dashboard'){ dbTopPeriod='month'; dbTopMetric='units'; dbWeekOffset=0; }
  if(name==='analytics'){ anTopPeriod='month'; anTopMetric='units'; anRevMonth='all'; anRevYear=new Date().getFullYear(); }
  if(builders[name])builders[name]();
  if(name==='inventory') checkExpiryAlerts();
  // ...then quietly pull the latest orders and redraw if a customer has bought something since
  if(name==='dashboard'||name==='analytics'||name==='orders'||name==='packing'){
    refreshAdminData(name).then(changed=>{
      const active=document.querySelector('.a-panel.on');
      if(changed && active && active.id==='ap-'+name && builders[name]) builders[name]();
    });
  }
}

function buildAdminAll(){buildDashboard();refreshAdminNotifBadge();updatePackingBadge();checkExpiryAlerts();}

/* DASHBOARD */
function buildDashboard(){
  const totalRev=ORDERS_DATA.filter(o=>o.status!=='Cancelled').reduce((s,o)=>s+o.total,0);
  const totalOrds=ORDERS_DATA.length;
  const pending=ORDERS_DATA.filter(o=>o.status==='Pending').length;
  const el=document.getElementById('ap-dashboard');
  el.innerHTML=`<div class="a-title">Dashboard</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Total Revenue</div><div class="kpi-val">${fmtPeso(totalRev)}</div><div class="kpi-sub up">▲ All time</div></div>
      <div class="kpi"><div class="kpi-label">Total Orders</div><div class="kpi-val">${totalOrds}</div><div class="kpi-sub">${pending} pending</div></div>
      <div class="kpi"><div class="kpi-label">Total Products</div><div class="kpi-val">${PRODUCTS.length}</div><div class="kpi-sub">${PRODUCTS.filter(p=>p.stock<30).length} low stock</div></div>
      <div class="kpi"><div class="kpi-label">Customers</div><div class="kpi-val">${CUSTOMERS_DATA.length}</div><div class="kpi-sub up">▲ Active</div></div>
    </div>
    <div class="chart-grid">
      <div class="a-card">
        <div class="a-card-head">
          <div><h3>Weekly Sales Revenue</h3><div id="db-week-sum" style="font-size:11.5px;color:#64748B;margin-top:3px"></div></div>
          <select id="db-week-sel" class="period-select" onchange="onDbWeekChange()">
            <option value="0">This Week</option>
            <option value="-1">Last Week</option>
          </select>
        </div>
        <div style="position:relative;height:200px"><canvas id="ch-sales"></canvas></div>
      </div>
      <div class="a-card"><h3>Order Status Breakdown</h3><div style="position:relative;height:200px"><canvas id="ch-status"></canvas></div></div>
    </div>
    <div class="a-card" style="margin-bottom:18px">
      <div class="a-card-head">
        <div><h3>Top Products</h3><div id="db-top-note" style="font-size:11.5px;color:#64748B;margin-top:3px"></div></div>
        <div style="display:flex;gap:8px">
          <select id="db-top-metric" class="period-select" onchange="onDbTopChange()">
            <option value="units">By Sales (Units)</option>
            <option value="revenue">By Revenue</option>
          </select>
          <select id="db-top-period" class="period-select" onchange="onDbTopChange()">
            <option value="week">Weekly</option>
            <option value="month" selected>Monthly</option>
            <option value="year">Yearly</option>
          </select>
        </div>
      </div>
      <div style="position:relative;height:220px"><canvas id="ch-db-top"></canvas></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Recent Orders</h3><button class="btn-add" onclick="aPanel('orders',document.getElementById('a-item-orders'))">View All</button></div>
      <table class="a-table"><thead><tr><th>Order ID</th><th>Customer</th><th>Items</th><th>Total</th><th>Status</th></tr></thead>
      <tbody>${ORDERS_DATA.slice(0,5).map(o=>`<tr><td>${o.id}</td><td>${o.customer}</td><td style="font-size:11px;color:#64748B;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.items}</td><td>${fmtPeso(o.total)}</td><td><span class="badge ${o.status==='Delivered'?'bg-green':o.status==='Shipped'?'bg-blue':o.status==='Processing'?'bg-amber':'bg-gray'}">${statusLabel(o.status)}</span></td></tr>`).join('')}</tbody>
      </table></div>`;
  document.getElementById('db-top-metric').value=dbTopMetric;
  document.getElementById('db-top-period').value=dbTopPeriod;
  document.getElementById('db-week-sel').value=String(dbWeekOffset);
  lastAdminSig=adminDataSignature();
  setTimeout(()=>{
    renderDbWeeklyChart();
    const ss=['Delivered','Shipped','Processing','Pending'];
    new Chart(document.getElementById('ch-status'),{type:'doughnut',data:{labels:ss.map(statusLabel),datasets:[{data:ss.map(s=>ORDERS_DATA.filter(o=>o.status===s).length),backgroundColor:['#16A34A','#2563EB','#D97706','#9CA3AF'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11},padding:8}}}}});
    renderDbTopChart();
  },80);
}

/* ANALYTICS: Revenue chart with Month + Year picker
   Built from the real orders the admin loaded (Cancelled orders are excluded).
   "Whole Year" = one point per month; picking a month = one point per day. */
const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
let anRevChart=null, anRevYear=new Date().getFullYear(), anRevMonth='all';

/* The API sends UTC timestamps without a 'Z'; add it so orders land in the
   admin's local (Philippine) month/day instead of the UTC one. */
function orderLocalDate(iso){
  if(!iso) return null;
  const s=/[zZ]|[+-]\d\d:?\d\d$/.test(iso)?iso:iso+'Z';
  const d=new Date(s);
  return isNaN(d)?null:d;
}
function revenueOrders(){
  return (ORDERS_DATA||[]).filter(o=>o.status!=='Cancelled').map(o=>({total:Number(o.total)||0,date:orderLocalDate(o.createdAt),lines:o.lines||[]})).filter(o=>o.date);
}
const REVENUE_YEAR_FROM=2025, REVENUE_YEAR_TO=2035;
function revenueYears(){
  const ys=new Set();
  for(let y=REVENUE_YEAR_FROM;y<=REVENUE_YEAR_TO;y++) ys.add(y);
  // safety: if any order falls outside 2025-2035, still offer that year
  revenueOrders().forEach(o=>ys.add(o.date.getFullYear()));
  ys.add(new Date().getFullYear());
  return [...ys].sort((a,b)=>a-b);
}
function onAnRevChange(){
  anRevMonth=document.getElementById('an-rev-month').value;
  anRevYear=parseInt(document.getElementById('an-rev-year').value);
  renderAnRevenueChart();
}
function renderAnRevenueChart(){
  const canvas=document.getElementById('ch-month');
  if(!canvas) return;
  const mSel=document.getElementById('an-rev-month'), ySel=document.getElementById('an-rev-year');
  if(mSel) mSel.value=anRevMonth;
  if(ySel) ySel.value=String(anRevYear);

  const now=new Date(), year=anRevYear, byMonth=anRevMonth!=='all', month=byMonth?parseInt(anRevMonth):null;
  const orders=revenueOrders().filter(o=>o.date.getFullYear()===year&&(!byMonth||o.date.getMonth()===month));

  let labels,data,title;
  if(!byMonth){
    labels=MONTH_NAMES.map(m=>m.slice(0,3));
    data=Array(12).fill(0);
    orders.forEach(o=>{data[o.date.getMonth()]+=o.total;});
    // leave future months empty so the line stops at today
    if(year===now.getFullYear()) for(let i=now.getMonth()+1;i<12;i++) data[i]=null;
    else if(year>now.getFullYear()) data=data.map(()=>null);
    title='Monthly Revenue '+year;
  } else {
    const days=new Date(year,month+1,0).getDate();
    labels=Array.from({length:days},(_,i)=>String(i+1));
    data=Array(days).fill(0);
    orders.forEach(o=>{data[o.date.getDate()-1]+=o.total;});
    const cut=new Date(year,month,1)>now?0:(year===now.getFullYear()&&month===now.getMonth()?now.getDate():days);
    for(let i=cut;i<days;i++) data[i]=null;
    title='Daily Revenue — '+MONTH_NAMES[month]+' '+year;
  }
  const total=orders.reduce((s,o)=>s+o.total,0);
  const t=document.getElementById('an-rev-title'); if(t) t.textContent=title;
  const sum=document.getElementById('an-rev-sum');
  if(sum) sum.textContent=`Total: ₱${total.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})} · ${orders.length} order${orders.length===1?'':'s'}`;

  if(anRevChart) anRevChart.destroy();
  anRevChart=new Chart(canvas,{type:'line',
    data:{labels,datasets:[{data,borderColor:'#4F7EF7',backgroundColor:'rgba(79,126,247,0.08)',tension:0.4,fill:true,label:'Revenue',pointBackgroundColor:'#4F7EF7',pointRadius:byMonth?3:4}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>'₱'+Number(c.parsed.y||0).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}}},
      scales:{y:{beginAtZero:true,suggestedMax:total>0?undefined:100,ticks:{callback:v=>'₱'+v.toLocaleString()},grid:{color:'#F1F5F9'}}}}});
}

/* ANALYTICS */
/* This calendar month vs last month, from real orders */
function monthlyStats(){
  const now=new Date(), thisStart=new Date(now.getFullYear(),now.getMonth(),1), prevStart=new Date(now.getFullYear(),now.getMonth()-1,1);
  const cur={rev:0,n:0}, prev={rev:0,n:0};
  revenueOrders().forEach(o=>{
    if(o.date>=thisStart){ cur.rev+=o.total; cur.n++; }
    else if(o.date>=prevStart){ prev.rev+=o.total; prev.n++; }
  });
  return {cur,prev};
}
function changeSub(cur,prev,emptyText){
  if(!prev) return `<div class="kpi-sub">${emptyText}</div>`;
  const pc=Math.round((cur-prev)/prev*100);
  return `<div class="kpi-sub ${pc>=0?'up':'dn'}">${pc>=0?'▲':'▼'} ${Math.abs(pc)}% vs last month</div>`;
}

function buildAnalytics(){
  const el=document.getElementById('ap-analytics');
  const ms=monthlyStats();
  const buyers=CUSTOMERS_DATA.filter(c=>c.orders>=1), repeatBuyers=buyers.filter(c=>c.orders>=2);
  const repeatPct=buyers.length?Math.round(repeatBuyers.length/buyers.length*100):0;
  el.innerHTML=`<div class="a-title">Analytics & Reports</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Monthly Revenue</div><div class="kpi-val">${fmtPeso(ms.cur.rev)}</div>${changeSub(ms.cur.rev,ms.prev.rev,'No sales last month')}</div>
      <div class="kpi"><div class="kpi-label">Monthly Orders</div><div class="kpi-val">${ms.cur.n}</div>${changeSub(ms.cur.n,ms.prev.n,'No orders last month')}</div>
      <div class="kpi"><div class="kpi-label">Avg Order Value</div><div class="kpi-val">${fmtPeso(ms.cur.n?ms.cur.rev/ms.cur.n:0)}</div><div class="kpi-sub">${ms.cur.n?'Per order this month':'No orders this month'}</div></div>
      <div class="kpi"><div class="kpi-label">Repeat Buyers</div><div class="kpi-val">${repeatPct}%</div><div class="kpi-sub up">${repeatBuyers.length} of ${buyers.length} buyer${buyers.length===1?'':'s'} ordered 2+ times</div></div>
    </div>
    <div class="chart-grid">
      <div class="a-card">
        <div class="a-card-head">
          <div><h3>Top Products by Sales</h3><div id="an-top-note" style="font-size:11.5px;color:#64748B;margin-top:3px"></div></div>
          <div style="display:flex;gap:8px">
            <select id="an-top-metric" class="period-select" onchange="onAnTopChange()">
              <option value="units">By Sales (Units)</option>
              <option value="revenue">By Revenue</option>
            </select>
            <select id="an-top-period" class="period-select" onchange="onAnTopChange()">
              <option value="week">Weekly</option>
              <option value="month" selected>Monthly</option>
              <option value="year">Yearly</option>
            </select>
          </div>
        </div>
        <div style="position:relative;height:200px"><canvas id="ch-prod"></canvas></div>
      </div>
      <div class="a-card"><h3>Customer Segments</h3><div style="position:relative;height:200px"><canvas id="ch-seg"></canvas></div></div>
    </div>
    <div class="a-card" style="margin-bottom:16px">
      <div class="a-card-head">
        <div><h3 id="an-rev-title">Monthly Revenue</h3><div id="an-rev-sum" style="font-size:11.5px;color:#64748B;margin-top:3px"></div></div>
        <div style="display:flex;gap:8px">
          <select id="an-rev-month" class="period-select" onchange="onAnRevChange()">
            <option value="all">Whole Year</option>
            ${MONTH_NAMES.map((m,i)=>`<option value="${i}">${m}</option>`).join('')}
          </select>
          <select id="an-rev-year" class="period-select" onchange="onAnRevChange()">
            ${revenueYears().map(y=>`<option value="${y}">${y}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="position:relative;height:150px"><canvas id="ch-month"></canvas></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Product Performance Report (<span id="an-top-period-label">${PERIOD_LABELS[anTopPeriod]}</span>)</h3><button class="btn-add" onclick="exportTopProductsCSV()">Export CSV</button></div>
      <table class="a-table"><thead><tr><th>Product</th><th>Category</th><th>Units Sold</th><th>Revenue</th><th>Status</th></tr></thead>
      <tbody id="an-top-tbody"></tbody></table></div>`;
  document.getElementById('an-top-metric').value=anTopMetric;
  document.getElementById('an-top-period').value=anTopPeriod;
  anRevChart=null;
  lastAdminSig=adminDataSignature();
  renderAnTopTable();
  setTimeout(()=>{
    renderAnTopChart();
    const l=CUSTOMERS_DATA.filter(c=>c.seg==='Loyal').length,o2=CUSTOMERS_DATA.filter(c=>c.seg==='Occasional').length,n=CUSTOMERS_DATA.filter(c=>c.seg==='New').length;
    new Chart(document.getElementById('ch-seg'),{type:'pie',data:{labels:[`Loyal (${l})`,`Occasional (${o2})`,`New (${n})`],datasets:[{data:[l,o2,n],backgroundColor:['#C2607E','#B8944A','#4F7EF7'],borderWidth:0,hoverOffset:8}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11}}}}}});
    renderAnRevenueChart();
  },80);
}

/* PRODUCTS */
function buildProducts(){
  const el=document.getElementById('ap-products');
  pfImageData=null;
  el.innerHTML=`<div class="a-title">Product Management</div>
    <div class="prod-form-card" id="prod-form-card">
      <h3 id="prod-form-title">Add New Product</h3>
      <div class="pf-grid">
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Product Name</label><input id="pf-name" placeholder="e.g. Michael Styling Gel 50ml"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Category</label><select id="pf-cat"><option>Hair Care</option><option>Alcohol</option><option>Body Care</option><option>Personal Care</option></select></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Price (₱)</label><input type="number" id="pf-price" placeholder="0.00" step="0.01"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Stock Qty</label><input type="number" id="pf-stock" placeholder="0"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Emoji Icon</label><input id="pf-emoji" placeholder="💄" maxlength="2" value="💄"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Product Image (JPEG)</label>
          <div style="display:flex;align-items:center;gap:10px">
            <div id="pf-image-preview" style="width:52px;height:52px;border-radius:8px;border:1.5px solid #E2E8F0;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#F8FAFC;flex-shrink:0"><span style="font-size:26px">💄</span></div>
            <input type="file" id="pf-image" accept="image/jpeg,.jpg,.jpeg" onchange="onProductImageSelected(event)" style="font-size:12px">
          </div>
        </div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Manufacturing Date</label><input type="date" id="pf-mfg"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Expiry Date</label><input type="date" id="pf-exp"></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Shop Label</label><select id="pf-badge"><option value="">None</option><option value="hot">🔥 Best Seller</option><option value="new">✨ New Arrival</option></select></div>
        <div><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Sale Price (₱) — empty = not on sale</label><input type="number" id="pf-sale" placeholder="e.g. 12.00" step="0.01" min="0"></div>
        <div class="full"><label style="font-size:11px;color:#64748B;display:block;margin-bottom:5px;text-transform:uppercase;letter-spacing:0.06em">Description</label><textarea id="pf-desc" placeholder="Product description..."></textarea></div>
      </div>
      <div class="pf-actions"><button class="btn-save" onclick="saveProduct()">Save Product</button><button class="btn-cancel-form" onclick="resetProductForm()">Cancel</button></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>All Products (<span id="prod-count">${PRODUCTS.length}</span>)</h3><button class="btn-add" onclick="resetProductForm();document.getElementById('pf-name').focus()">+ Add New</button></div>
      <table class="a-table"><thead><tr><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Expiry</th><th>Promo</th><th>Actions</th></tr></thead>
      <tbody id="prod-tbody">${renderProdRows()}</tbody>
      </table></div>`;
}

function renderProdRows(){
  return PRODUCTS.map(p=>`
    <tr id="prow-${p.id}">
      <td><span style="margin-right:7px;font-size:16px">${p.e}</span>${p.name}</td>
      <td><span class="badge bg-gray">${p.cat}</span></td>
      <td>₱${p.price.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
      <td><span class="badge ${p.stock===0?'bg-red':p.stock<30?'bg-amber':'bg-green'}">${p.stock}</span></td>
      <td>${p.stock===0?'<span class="badge bg-red">Out of Stock</span>':p.stock<30?'<span class="badge bg-amber">Low Stock</span>':'<span class="badge bg-green">In Stock</span>'}</td>
      <td>${expiryBadge(p)}${p.mfg?`<div style="font-size:10px;color:#94A3B8;margin-top:2px">Mfg ${fmtDate(p.mfg)}</div>`:''}</td>
      <td>
        <select class="period-select" title="Best Sellers / New Arrivals label" onchange="quickSetBadge(${p.id},this.value)">
          <option value="" ${!p.badge?'selected':''}>—</option>
          <option value="hot" ${p.badge==='hot'?'selected':''}>🔥 Best Seller</option>
          <option value="new" ${p.badge==='new'?'selected':''}>✨ New Arrival</option>
        </select>
        ${saleActive(p)?`<div style="font-size:10px;color:#B45309;margin-top:4px;font-weight:600">⚡ Sale ${fmtPeso(p.salePrice)} (−${salePct(p)}%)</div>`:''}
      </td>
      <td><button class="btn-edit" onclick="editProduct(${p.id})">Edit</button><button class="btn-del" onclick="deleteProduct(${p.id})">Delete</button></td>
    </tr>`).join('');
}

/* Reads a selected JPEG file into a base64 data URL for the product image preview + payload */
/* Reads a selected JPEG file, downsizes it on a canvas, and re-encodes it as a
   compressed JPEG data URL (keeps payloads small so the request doesn't get
   dropped for being too large — raw phone/screenshot images can be several MB). */
function onProductImageSelected(e){
  const file=e.target.files[0];
  if(!file) return;
  const isJpeg = file.type==='image/jpeg' || /\.jpe?g$/i.test(file.name);
  if(!isJpeg){ showToast('Please select a JPEG image.'); e.target.value=''; return; }

  const img=new Image();
  const objectUrl=URL.createObjectURL(file);
  img.onload=()=>{
    const MAX_DIM=800;
    let {width,height}=img;
    if(width>height && width>MAX_DIM){ height=Math.round(height*(MAX_DIM/width)); width=MAX_DIM; }
    else if(height>MAX_DIM){ width=Math.round(width*(MAX_DIM/height)); height=MAX_DIM; }
    const canvas=document.createElement('canvas');
    canvas.width=width; canvas.height=height;
    canvas.getContext('2d').drawImage(img,0,0,width,height);
    pfImageData=canvas.toDataURL('image/jpeg',0.72); // re-encoded, compressed JPEG — typically tens of KB
    URL.revokeObjectURL(objectUrl);
    const prev=document.getElementById('pf-image-preview');
    if(prev) prev.innerHTML=`<img src="${pfImageData}" style="width:100%;height:100%;object-fit:cover">`;
  };
  img.onerror=()=>{ URL.revokeObjectURL(objectUrl); showToast('Could not read that image.'); e.target.value=''; };
  img.src=objectUrl;
}

function updateProdCount(){
  const cnt=document.getElementById('prod-count');
  if(cnt) cnt.textContent=PRODUCTS.length;
}

async function saveProduct(){
  const name=document.getElementById('pf-name').value.trim();
  const cat=document.getElementById('pf-cat').value;
  const price=parseFloat(document.getElementById('pf-price').value);
  const stock=parseInt(document.getElementById('pf-stock').value);
  const emoji=document.getElementById('pf-emoji').value||'💄';
  const desc=document.getElementById('pf-desc').value.trim();
  const mfg=document.getElementById('pf-mfg').value||null;
  const exp=document.getElementById('pf-exp').value||null;
  if(!name||!price||isNaN(stock)){showToast('Please fill in all required fields.');return;}
  if(mfg&&exp&&exp<=mfg){showToast('Expiry date must be after the manufacturing date.');return;}
  const badge=document.getElementById('pf-badge').value;
  const saleRaw=document.getElementById('pf-sale').value.trim();
  const sale=saleRaw===''?0:parseFloat(saleRaw);          // 0 = not on sale
  if(saleRaw!==''&&(isNaN(sale)||sale<=0)){showToast('Enter a sale price above 0, or leave it empty.');return;}
  if(sale>0&&sale>=price){showToast('The sale price must be lower than the regular price.');return;}
  const payload={name,category:cat,price,stock,emoji,description:desc,manufacture_date:mfg,expiry_date:exp,badge,sale_price:sale};
  if(pfImageData) payload.image_url=pfImageData; // only sent when admin picked a new JPEG; leaves existing image untouched otherwise
  try {
    if(editingProductId){
      await apiFetch('/products/'+editingProductId, { method:'PUT', body: JSON.stringify(payload) });
      showToast('Product updated.');
    } else {
      await apiFetch('/products', { method:'POST', body: JSON.stringify(payload) });
      showToast('Product added.');
    }
    await loadProducts();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  resetProductForm();
  document.getElementById('prod-tbody').innerHTML=renderProdRows();
  updateProdCount();
}

/* Changes a product's Best Seller / New Arrival label straight from the table */
async function quickSetBadge(id,value){
  const p=PRODUCTS.find(x=>x.id===id); if(!p) return;
  try {
    await apiFetch('/products/'+id, { method:'PUT', body: JSON.stringify({ badge: value }) });
    await loadProducts();
  } catch(e){ showToast('⚠️ '+e.message); document.getElementById('prod-tbody').innerHTML=renderProdRows(); return; }
  document.getElementById('prod-tbody').innerHTML=renderProdRows();
  showToast(value==='hot'?'🔥 '+p.name+' is now a Best Seller.':value==='new'?'✨ '+p.name+' is now a New Arrival.':'Label removed from '+p.name+'.');
}

function editProduct(id){
  const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
  editingProductId=id;
  pfImageData=null;
  document.getElementById('prod-form-title').textContent='Edit Product';
  document.getElementById('pf-name').value=p.name;
  document.getElementById('pf-cat').value=p.cat;
  document.getElementById('pf-price').value=p.price;
  document.getElementById('pf-stock').value=p.stock;
  document.getElementById('pf-emoji').value=p.e;
  document.getElementById('pf-desc').value=p.desc;
  document.getElementById('pf-mfg').value=p.mfg||'';
  document.getElementById('pf-exp').value=p.exp||'';
  document.getElementById('pf-badge').value=p.badge||'';
  document.getElementById('pf-sale').value=p.salePrice||'';
  const imgInput=document.getElementById('pf-image'); if(imgInput) imgInput.value='';
  const prev=document.getElementById('pf-image-preview');
  if(prev) prev.innerHTML = p.image ? `<img src="${p.image}" style="width:100%;height:100%;object-fit:cover">` : `<span style="font-size:26px">${p.e||'💄'}</span>`;
  document.getElementById('prod-form-card').scrollIntoView({behavior:'smooth'});
}

async function deleteProduct(id){
  if(!confirm('Delete this product? This cannot be undone.'))return;
  try {
    await apiFetch('/products/'+id, { method:'DELETE' });
    await loadProducts();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  document.getElementById('prod-tbody').innerHTML=renderProdRows();
  updateProdCount();
  showToast('Product deleted.');
}

function resetProductForm(){
  editingProductId=null;
  pfImageData=null;
  document.getElementById('prod-form-title').textContent='Add New Product';
  ['pf-name','pf-price','pf-stock','pf-desc','pf-mfg','pf-exp','pf-sale'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('pf-emoji').value='💄';
  document.getElementById('pf-badge').value='';
  const imgInput=document.getElementById('pf-image'); if(imgInput) imgInput.value='';
  const prev=document.getElementById('pf-image-preview'); if(prev) prev.innerHTML='<span style="font-size:26px">💄</span>';
}

/* ORDERS */
function buildOrders(){
  const pend=ORDERS_DATA.filter(o=>o.status==='Pending').length;
  const proc=ORDERS_DATA.filter(o=>o.status==='Processing').length;
  const ship=ORDERS_DATA.filter(o=>o.status==='Shipped').length;
  const deliv=ORDERS_DATA.filter(o=>o.status==='Delivered').length;
  document.getElementById('ap-orders').innerHTML=`<div class="a-title">Order Management</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Total Orders</div><div class="kpi-val">${ORDERS_DATA.length}</div></div>
      <div class="kpi"><div class="kpi-label">Pending</div><div class="kpi-val dn">${pend}</div></div>
      <div class="kpi"><div class="kpi-label">Processing</div><div class="kpi-val" style="color:#D97706">${proc}</div></div>
      <div class="kpi"><div class="kpi-label">Delivered</div><div class="kpi-val up">${deliv}</div></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>All Orders</h3><button class="btn-add" onclick="exportOrdersCSV()">Export CSV</button></div>
      <table class="a-table" style="table-layout:fixed;width:100%">
        <thead><tr><th style="width:90px">Order ID</th><th style="width:110px">Customer</th><th>Items</th><th style="width:80px">Total</th><th style="width:55px">Date</th><th style="width:90px">Status</th><th style="width:55px">Proof</th><th style="width:115px">Update Status</th></tr></thead>
        <tbody id="orders-tbody">${renderOrderRows()}</tbody>
      </table></div>`;
}

function renderOrderRows(){
  const deliveryPhotos=loadDeliveryPhotos();
  return ORDERS_DATA.map(o=>{
    const proof=deliveryPhotos[o.id];
    return `
    <tr id="ord-row-${o.id}">
      <td style="font-weight:600;color:var(--admin-accent)">${o.id}</td>
      <td>${o.customer}</td>
      <td style="font-size:11px;color:#64748B;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${o.items}</td>
      <td>${fmtPeso(o.total)}</td>
      <td>${o.date}</td>
      <td id="ord-badge-${o.id}"><span class="badge ${o.status==='Delivered'?'bg-green':o.status==='Shipped'?'bg-blue':o.status==='Processing'?'bg-amber':o.status==='Cancelled'?'bg-red':'bg-gray'}" ${o.cancelReason?`title="Cancelled: ${o.cancelReason.replace(/"/g,'&quot;')}"`:''}>${statusLabel(o.status)}</span>${o.status==='Processing'&&o.packedAt?'<div style="font-size:10px;color:#166534;margin-top:3px;font-weight:600">📦 Packed</div>':''}</td>
      <td>${proof?`<img src="${proof.photo}" class="proof-thumb" onclick="viewDeliveryPhoto('${o.id}')" alt="proof" title="View delivery photo">`:'<span style="color:#CBD5E1;font-size:11px">—</span>'}</td>
      <td>
        <select style="font-size:11px;border:1px solid #E2E8F0;border-radius:6px;padding:4px 6px;width:100%;outline:none" onchange="updateOrderStatus('${o.id}',this.value)">
          ${['Pending','Processing','Shipped','Delivered'].map(s=>`<option value="${s}" ${s===o.status?'selected':''}>${statusLabel(s)}</option>`).join('')}
        </select>
      </td>
    </tr>`;
  }).join('');
}

async function updateOrderStatus(orderId,newStatus){
  const order=ORDERS_DATA.find(o=>o.id===orderId);
  if(!order||order.status===newStatus)return;
  try {
    await apiFetch('/orders/'+order.dbId+'/status', { method:'PATCH', body: JSON.stringify({ status: newStatus }) });
    await loadOrders(); // refreshes ORDERS_DATA for admin
  } catch(e){ showToast('⚠️ '+e.message); return; }
  showToast('Order '+orderId+' → '+statusLabel(newStatus)+'. Customer notified.');
  buildOrders();
}

/* ═══ PACKING (staff screen) ═══
   Staff see every order that is in Processing, with exactly what to pack. When the
   items are packed they press "Mark as Packed": the customer is notified that the order
   is ready for delivery, and the admin can then move it to "For Delivery". */
function updatePackingBadge(){
  const el=document.getElementById('a-item-packing');
  if(!el) return;
  const n=ORDERS_DATA.filter(o=>o.status==='Processing'&&!o.packedAt).length;
  el.textContent='Packing'+(n?' ('+n+')':'');
}

function buildPacking(){
  const byDate=(a,b)=>(orderLocalDate(a.createdAt)||0)-(orderLocalDate(b.createdAt)||0);   // oldest first
  const processing=ORDERS_DATA.filter(o=>o.status==='Processing');
  const toPack=processing.filter(o=>!o.packedAt).sort(byDate);
  const packed=processing.filter(o=>o.packedAt).sort(byDate);
  const forDelivery=ORDERS_DATA.filter(o=>o.status==='Shipped').length;
  const rows=[...toPack,...packed];

  const itemsHtml=o=>(o.lines&&o.lines.length)
    ? o.lines.map(l=>`<div><b>${l.qty}</b> × ${escHtml(l.name)}</div>`).join('')
    : escHtml(o.items);
  const packedTime=o=>{
    const d=orderLocalDate(o.packedAt);
    return d?d.toLocaleString('en-PH',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
  };

  document.getElementById('ap-packing').innerHTML=`<div class="a-title">Packing Station</div>
    <div style="font-size:13px;color:#64748B;margin:-6px 0 16px">For staff: pack the items, then press <b>Mark as Packed</b> so the customer knows the order is ready for delivery.</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">To Pack</div><div class="kpi-val ${toPack.length?'dn':''}">${toPack.length}</div><div class="kpi-sub">Orders in Processing</div></div>
      <div class="kpi"><div class="kpi-label">Packed — Ready</div><div class="kpi-val up">${packed.length}</div><div class="kpi-sub">Waiting to be set For Delivery</div></div>
      <div class="kpi"><div class="kpi-label">For Delivery</div><div class="kpi-val">${forDelivery}</div><div class="kpi-sub">On their way to customers</div></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Orders to Pack (oldest first)</h3></div>
      <table class="a-table"><thead><tr><th>Order</th><th>Customer</th><th>Items to Pack</th><th>Deliver To</th><th>Placed</th><th>Action</th></tr></thead>
      <tbody>${rows.length?rows.map(o=>`
        <tr>
          <td style="font-weight:600;color:var(--admin-accent)">${o.id}</td>
          <td>${escHtml(o.customer)}</td>
          <td style="font-size:12px;line-height:1.6">${itemsHtml(o)}</td>
          <td style="font-size:12px;color:#64748B;max-width:220px">${escHtml(o.address||'—')}</td>
          <td>${o.date}</td>
          <td>${o.packedAt
            ? `<span class="badge bg-green">✓ Packed ${packedTime(o)}</span><button class="btn-edit" style="margin:6px 0 0 0;display:block" onclick="packingSetForDelivery('${o.id}')">🚚 Set For Delivery</button>`
            : `<button class="btn-save-inline" onclick="markOrderPacked('${o.id}')">📦 Mark as Packed</button>`}</td>
        </tr>`).join('')
        : `<tr><td colspan="6" style="text-align:center;padding:28px;color:#64748B">No orders to pack right now 🎉</td></tr>`}
      </tbody></table></div>`;
  updatePackingBadge();
  lastAdminSig=adminDataSignature();
}

async function markOrderPacked(orderId){
  const order=ORDERS_DATA.find(o=>o.id===orderId);
  if(!order||order.status!=='Processing'||order.packedAt) return;
  if(!confirm('Mark '+orderId+' as packed? The customer will be notified that it is ready for delivery.')) return;
  try {
    await apiFetch('/orders/'+order.dbId+'/packed',{ method:'POST' });
    await loadOrders();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  showToast('📦 '+orderId+' marked as packed. Customer notified.');
  buildPacking();
}

async function packingSetForDelivery(orderId){
  if(!confirm('Set '+orderId+' to For Delivery? The customer will be notified.')) return;
  await updateOrderStatus(orderId,'Shipped');     // same call the Orders page uses
  buildPacking();
}

/* ═══ DELIVERIES (admin map) ═══
   Shows every order that is "For Delivery" on a map, in the order the rider should visit
   them (Rush first, then nearest next), with the rider's live position. The rider shares
   their location from their own phone (rider.html); customers see the same position on
   their order page. The map is OpenStreetMap via Leaflet (no API key needed). */
const CDO_CENTER=[8.4542,124.6319];
const DV_COLORS={current:'#F59E0B',pending:'#6B7280',done:'#16A34A',rush:'#DC2626',rider:'#2563EB'};
let delivMap=null, delivLayer=null, delivBoard=null, delivSig='', delivPinFor=null, delivFitted=false;
let delivRoutes={}, delivFetching=new Set(), delivPrevStatus=null;

function haversineKm(a,b){
  const R=6371, rad=x=>x*Math.PI/180;
  const dLat=rad(b[0]-a[0]), dLng=rad(b[1]-a[1]);
  const h=Math.sin(dLat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(h));
}
function timeAgo(iso){
  if(!iso) return '';
  const t=new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso)?iso:iso+'Z').getTime();
  const s=Math.max(0,Math.round((Date.now()-t)/1000));
  if(s<60) return s+' sec ago';
  if(s<3600) return Math.round(s/60)+' min ago';
  return Math.round(s/3600)+' hr ago';
}

/* Visiting order for one rider: Rush stops first, then always the nearest next stop, starting from the rider */
function orderStops(start,stops){
  const nearest=(from,list)=>{
    const left=list.slice(), out=[]; let cur=from;
    while(left.length){
      let bi=0;
      if(cur){ let best=Infinity; left.forEach((s,i)=>{ const d=haversineKm(cur,[s.lat,s.lng]); if(d<best){ best=d; bi=i; } }); }
      const s=left.splice(bi,1)[0]; out.push(s); cur=[s.lat,s.lng];
    }
    return out;
  };
  const rush=nearest(start,stops.filter(s=>s.is_rush));
  const last=rush.length?[rush[rush.length-1].lat,rush[rush.length-1].lng]:start;
  return rush.concat(nearest(last,stops.filter(s=>!s.is_rush)));
}

/* Turns the server's board into what to draw */
function delivPlan(board){
  const active=board.orders.filter(o=>o.status==='Shipped');
  const placed=active.filter(o=>o.lat!=null);
  const riderIds=new Set(board.riders.map(r=>r.id));
  return {
    done: board.orders.filter(o=>o.status==='Delivered'&&o.lat!=null),
    needsPin: active.filter(o=>o.lat==null),
    unassigned: placed.filter(o=>o.rider_id==null||!riderIds.has(o.rider_id)),
    riders: board.riders.map(r=>({
      rider:r,
      stops: orderStops(r.lat!=null?[r.lat,r.lng]:null, placed.filter(o=>o.rider_id===r.id))
              .map((o,i)=>({o,seq:i+1,state:i===0?'current':'pending'}))
    }))
  };
}

function dvIcon(label,color,big){
  const size=big?34:28;
  return L.divIcon({className:'dv-pin',iconSize:[size,size],iconAnchor:[size/2,size/2],
    html:`<div class="dv-dot" style="background:${color};width:${size}px;height:${size}px;line-height:${size-4}px">${label}</div>`});
}
const dvTruckIcon=()=>L.divIcon({className:'dv-pin',iconSize:[38,38],iconAnchor:[19,19],html:'<div class="dv-truck">🚚</div>'});

async function fetchRoadRoute(points){
  const coords=points.map(p=>p[1]+','+p[0]).join(';');
  const res=await fetch('https://router.project-osrm.org/route/v1/driving/'+coords+'?overview=full&geometries=geojson');
  const data=await res.json();
  if(data.code!=='Ok') throw new Error('no route');
  return data.routes[0].geometry.coordinates.map(c=>[c[1],c[0]]);
}
/* Draws the rider -> stops route. Road route when available, otherwise a dashed straight line. */
function drawRoute(rider,stops){
  if(!stops.length) return;
  const pts=[[rider.lat,rider.lng]].concat(stops.map(s=>[s.o.lat,s.o.lng]));
  const sig=pts.map(p=>p[0].toFixed(3)+','+p[1].toFixed(3)).join('|');
  const cached=delivRoutes[rider.id];
  if(cached&&cached.sig===sig){
    L.polyline(cached.latlngs,cached.failed?{color:'#3B82F6',weight:3,opacity:.6,dashArray:'6 8'}:{color:'#3B82F6',weight:5,opacity:.85}).addTo(delivLayer);
    return;
  }
  L.polyline(pts,{color:'#3B82F6',weight:3,opacity:.6,dashArray:'6 8'}).addTo(delivLayer);
  const key=rider.id+':'+sig;
  if(delivFetching.has(key)) return;
  delivFetching.add(key);
  fetchRoadRoute(pts)
    .then(latlngs=>{ delivRoutes[rider.id]={sig,latlngs}; })
    .catch(()=>{ delivRoutes[rider.id]={sig,latlngs:pts,failed:true}; })
    .finally(()=>{ delivFetching.delete(key); if(delivRoutes[rider.id]&&!delivRoutes[rider.id].failed) drawDeliveryMap(); });
}

function drawDeliveryMap(){
  if(!delivMap||!delivLayer||!delivBoard) return;
  delivLayer.clearLayers();
  const plan=delivPlan(delivBoard), bounds=[];
  const pin=(o,label,color,big,tip)=>{
    L.marker([o.lat,o.lng],{icon:dvIcon(label,color,big)}).addTo(delivLayer).bindTooltip(tip);
    bounds.push([o.lat,o.lng]);
  };
  plan.done.forEach(o=>pin(o,'✓',DV_COLORS.done,false,escHtml(o.order_number)+' · '+escHtml(o.customer)+' · Delivered'));
  plan.unassigned.forEach(o=>pin(o,'•',o.is_rush?DV_COLORS.rush:DV_COLORS.pending,false,escHtml(o.order_number)+' · '+escHtml(o.customer)+' · No rider yet'+(o.is_rush?' · RUSH':'')));
  plan.riders.forEach(({rider,stops})=>{
    stops.forEach(({o,seq,state})=>pin(o,String(seq),o.is_rush?DV_COLORS.rush:state==='current'?DV_COLORS.current:DV_COLORS.pending,state==='current',
      '#'+seq+' '+escHtml(o.order_number)+' · '+escHtml(o.customer)+(state==='current'?' · Current stop':'')+(o.is_rush?' · RUSH':'')));
    if(rider.lat!=null){
      L.marker([rider.lat,rider.lng],{icon:dvTruckIcon(),zIndexOffset:1000}).addTo(delivLayer)
        .bindTooltip(escHtml(rider.name)+' · '+(rider.fresh?'live':'last seen '+timeAgo(rider.updated_at)));
      bounds.push([rider.lat,rider.lng]);
      drawRoute(rider,stops);
    }
  });
  if(!delivFitted&&bounds.length){ delivMap.fitBounds(bounds,{padding:[50,50],maxZoom:15}); delivFitted=true; }
}

function renderDeliveryTables(){
  const b=delivBoard, plan=delivPlan(b);
  const active=b.orders.filter(o=>o.status==='Shipped'), done=b.orders.filter(o=>o.status==='Delivered');
  const live=b.riders.filter(r=>r.fresh).length;
  document.getElementById('dv-kpis').innerHTML=`
    <div class="kpi"><div class="kpi-label">For Delivery</div><div class="kpi-val">${active.length}</div><div class="kpi-sub">Out with riders</div></div>
    <div class="kpi"><div class="kpi-label">Delivered Today</div><div class="kpi-val up">${done.length}</div><div class="kpi-sub">Completed</div></div>
    <div class="kpi"><div class="kpi-label">Riders Live</div><div class="kpi-val">${live}<span style="font-size:15px;color:#94A3B8"> / ${b.riders.length}</span></div><div class="kpi-sub">Sharing their location</div></div>
    <div class="kpi"><div class="kpi-label">Needs a Pin</div><div class="kpi-val ${plan.needsPin.length?'dn':''}">${plan.needsPin.length}</div><div class="kpi-sub">Address not on the map</div></div>`;

  const seqOf={};
  plan.riders.forEach(({stops})=>stops.forEach(s=>{ seqOf[s.o.id]=s; }));
  const badge=(txt,color)=>`<span class="dv-badge" style="background:${color}">${txt}</span>`;
  const rows=active.concat(done).map(o=>{
    const isDone=o.status==='Delivered', s=seqOf[o.id];
    const stopCell=isDone?badge('Delivered',DV_COLORS.done)
      :o.is_rush?badge('Rush'+(s?' · #'+s.seq:''),DV_COLORS.rush)
      :s?badge((s.state==='current'?'Current':'Pending')+' · #'+s.seq,s.state==='current'?DV_COLORS.current:DV_COLORS.pending)
      :badge('Waiting for a rider',DV_COLORS.pending);
    const riderSel=isDone?'—':`<select style="font-size:12px;border:1px solid #E2E8F0;border-radius:6px;padding:4px 6px" onchange="assignRider(${o.id},this.value)">
        <option value="">— no rider —</option>${b.riders.map(r=>`<option value="${r.id}" ${o.rider_id===r.id?'selected':''}>${escHtml(r.name)}</option>`).join('')}</select>`;
    const rush=isDone?'':`<input type="checkbox" ${o.is_rush?'checked':''} onchange="toggleRush(${o.id},this.checked)" title="Deliver this one first">`;
    const where=o.lat!=null?`<span style="color:#16A34A;font-size:12px">✓ on map</span> <a href="#" style="font-size:11px;color:#64748B" onclick="startPin(${o.id},'${escJS(o.order_number)}');return false;">re-pin</a>`
      :`<button class="btn-edit" onclick="startPin(${o.id},'${escJS(o.order_number)}')">📍 Pin on map</button>`;
    return `<tr style="${isDone?'opacity:.6':''}">
      <td style="font-weight:600;color:var(--admin-accent)">${escHtml(o.order_number)}</td>
      <td>${escHtml(o.customer)}</td>
      <td style="font-size:12px;color:#64748B;max-width:240px">${escHtml(o.address||'—')}</td>
      <td>${stopCell}</td><td>${riderSel}</td><td style="text-align:center">${rush}</td><td>${isDone&&o.lat==null?'—':where}</td></tr>`;
  });
  document.getElementById('dv-orders').innerHTML=rows.length?rows.join('')
    :`<tr><td colspan="7" style="text-align:center;padding:28px;color:#64748B">No orders are out for delivery right now. Set an order to <b>For Delivery</b> and it appears here.</td></tr>`;

  document.getElementById('dv-riders').innerHTML=b.riders.length?b.riders.map(r=>`
    <div class="dv-rider-row">
      <span class="dv-live" style="background:${r.fresh?'#16A34A':r.lat!=null?'#F59E0B':'#CBD5E1'}"></span>
      <b>${escHtml(r.name)}</b>
      <span style="font-size:12px;color:#475569">${r.phone?'📞 '+escHtml(r.phone):'<span style="color:#DC2626">No phone number</span>'}</span>
      <span style="color:#64748B;font-size:12px">${r.fresh?'Live now':r.lat!=null?'Last seen '+timeAgo(r.updated_at):'Not sharing yet'}</span>
      <span style="flex:1"></span>
      <button class="btn-edit" onclick="editRiderPhone(${r.id},'${escJS(r.phone||'')}')">✏️ Phone</button>
      <button class="btn-edit" onclick="copyRiderLink('${escJS(r.token)}')">📋 Copy rider link</button>
      <button class="btn-del" onclick="removeRider(${r.id},'${escJS(r.name)}')">Remove</button>
    </div>`).join('')
    :`<div style="color:#64748B;font-size:13px;padding:6px 0">No riders yet. Add one below, then send them their link.</div>`;
}

async function refreshDeliveries(force){
  let board;
  try { board=await apiFetch('/delivery/board'); }
  catch(e){ const u=document.getElementById('dv-updated'); if(u) u.textContent='⚠️ Could not load deliveries: '+e.message; return; }
  delivBoard=board;
  // tell the admin the moment a rider marks an order delivered
  if(delivPrevStatus){
    board.orders.forEach(o=>{
      if(o.status==='Delivered'&&delivPrevStatus[o.id]==='Shipped'){
        const r=board.riders.find(x=>x.id===o.rider_id);
        showToast('✅ '+o.order_number+' was delivered'+(r?' by '+r.name:'')+'.');
      }
    });
  }
  delivPrevStatus={}; board.orders.forEach(o=>{ delivPrevStatus[o.id]=o.status; });
  const sig=JSON.stringify([board.orders.map(o=>[o.id,o.status,o.rider_id,o.is_rush,o.lat!=null]),board.riders.map(r=>[r.id,r.name,r.fresh])]);
  if(force||sig!==delivSig){ delivSig=sig; if(document.getElementById('dv-orders')) renderDeliveryTables(); }
  drawDeliveryMap();
  const u=document.getElementById('dv-updated');
  if(u) u.textContent='Updated '+new Date().toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+' · refreshes every 15 seconds · route lines follow the roads when available';
}

async function buildDeliveries(){
  const el=document.getElementById('ap-deliveries');
  el.innerHTML=`<div class="a-title">Deliveries</div>
    <div style="font-size:13px;color:#64748B;margin:-6px 0 16px">Orders that are <b>For Delivery</b> today. Orders are given to an available rider <b>automatically</b> (a rider is available while their phone is sharing its location). You can still change the rider by hand. The customer sees the rider's name, phone number and live location on their order page.</div>
    <div id="dv-kpis" class="kpi-grid"></div>
    <div class="a-card" style="margin-bottom:16px;padding:0;overflow:hidden">
      <div class="dv-map-wrap"><div id="dv-map"></div>
        <div class="dv-legend"><span class="lg"><i style="background:${DV_COLORS.rider}"></i>Rider 🚚</span><span class="lg"><i style="background:${DV_COLORS.current}"></i>Current</span><span class="lg"><i style="background:${DV_COLORS.done}"></i>Completed</span><span class="lg"><i style="background:${DV_COLORS.pending}"></i>Pending</span><span class="lg"><i style="background:${DV_COLORS.rush}"></i>Rush</span></div>
        <div id="dv-hint" class="dv-hint" style="display:none"></div></div>
      <div id="dv-updated" style="font-size:11.5px;color:#64748B;padding:9px 16px">Loading…</div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Today's Deliveries</h3></div>
      <table class="a-table"><thead><tr><th>Order</th><th>Customer</th><th>Deliver To</th><th>Stop</th><th>Rider</th><th>Rush</th><th>Map Pin</th></tr></thead>
      <tbody id="dv-orders"></tbody></table></div>
    <div class="a-card" style="margin-top:16px"><h3>Riders</h3>
      <div id="dv-riders"></div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <input id="dv-rider-name" placeholder="Rider's name" maxlength="40" style="flex:1;min-width:180px;border:1.5px solid #E2E8F0;border-radius:8px;padding:9px 12px;font-size:13px" onkeydown="if(event.key==='Enter')addRider()">
        <input id="dv-rider-phone" placeholder="Phone (customers will see it)" maxlength="20" inputmode="tel" style="flex:1;min-width:180px;border:1.5px solid #E2E8F0;border-radius:8px;padding:9px 12px;font-size:13px" onkeydown="if(event.key==='Enter')addRider()">
        <button class="btn-save-inline" onclick="addRider()">+ Add rider</button>
      </div>
    </div>`;
  if(delivMap){ try{ delivMap.remove(); }catch(e){} delivMap=null; delivLayer=null; }
  delivFitted=false; delivPinFor=null; delivSig=''; delivRoutes={}; delivFetching=new Set(); delivPrevStatus=null;
  if(typeof L==='undefined'){
    document.getElementById('dv-map').innerHTML='<div style="padding:60px 20px;text-align:center;color:#64748B">The map could not load. Check your internet connection and refresh the page.</div>';
  } else {
    delivMap=L.map('dv-map').setView(CDO_CENTER,12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(delivMap);
    delivLayer=L.layerGroup().addTo(delivMap);
    delivMap.on('click',onDeliveryMapClick);
    setTimeout(()=>{ if(delivMap) delivMap.invalidateSize(); },250);
  }
  await refreshDeliveries(true);
}

async function deliveryPatch(orderDbId,body,okMsg){
  try { await apiFetch('/delivery/orders/'+orderDbId,{ method:'PATCH', body: JSON.stringify(body) }); }
  catch(e){ showToast('⚠️ '+e.message); await refreshDeliveries(true); return false; }
  if(okMsg) showToast(okMsg);
  await refreshDeliveries(true);
  return true;
}
function assignRider(orderDbId,value){
  deliveryPatch(orderDbId, value===''?{clear_rider:true}:{rider_id:parseInt(value)}, value===''?'Rider removed from the order.':'🚚 Order given to the rider.');
}
function toggleRush(orderDbId,checked){
  deliveryPatch(orderDbId,{is_rush:checked},checked?'🔴 Marked as Rush. It moves to the front of the route.':'Rush removed.');
}
function startPin(orderDbId,orderNo){
  if(!delivMap){ showToast('The map is not available.'); return; }
  delivPinFor=orderDbId;
  const hint=document.getElementById('dv-hint');
  hint.textContent='📍 Click the map where '+orderNo+' should be delivered';
  hint.style.display='block';
  delivMap.getContainer().style.cursor='crosshair';
  document.getElementById('dv-map').scrollIntoView({behavior:'smooth',block:'center'});
}
async function onDeliveryMapClick(e){
  if(delivPinFor==null) return;
  const id=delivPinFor; delivPinFor=null;
  document.getElementById('dv-hint').style.display='none';
  delivMap.getContainer().style.cursor='';
  await deliveryPatch(id,{lat:e.latlng.lat,lng:e.latlng.lng},'📍 Location saved.');
}
async function addRider(){
  const nameEl=document.getElementById('dv-rider-name'), phoneEl=document.getElementById('dv-rider-phone');
  const name=nameEl.value.trim(), phone=phoneEl.value.trim();
  if(!name){ showToast("Enter the rider's name first."); return; }
  if(!phone){ showToast("Enter the rider's phone number so customers can contact them."); return; }
  try { await apiFetch('/delivery/riders',{ method:'POST', body: JSON.stringify({ name, phone }) }); }
  catch(e){ showToast('⚠️ '+e.message); return; }
  nameEl.value=''; phoneEl.value='';
  showToast('✅ Rider added. Press "Copy rider link" and send it to them.');
  refreshDeliveries(true);
}
async function editRiderPhone(id,current){
  const value=prompt("Rider's phone number (customers will see it):",current||'');
  if(value===null) return;
  try { await apiFetch('/delivery/riders/'+id,{ method:'PATCH', body: JSON.stringify({ phone: value.trim() }) }); }
  catch(e){ showToast('⚠️ '+e.message); return; }
  showToast('✅ Phone number saved.');
  refreshDeliveries(true);
}
async function removeRider(id,name){
  if(!confirm('Remove '+name+'? Their orders become unassigned and their link stops working.')) return;
  try { await apiFetch('/delivery/riders/'+id,{ method:'DELETE' }); }
  catch(e){ showToast('⚠️ '+e.message); return; }
  showToast('Rider removed.');
  refreshDeliveries(true);
}
function copyRiderLink(token){
  const link=new URL('rider.html?t='+encodeURIComponent(token),location.href).href;
  const done=()=>showToast('📋 Rider link copied. Send it to the rider (Messenger, SMS).');
  if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done).catch(()=>prompt('Copy this rider link:',link));
  else prompt('Copy this rider link:',link);
}
// While the admin is on the Deliveries screen, refresh the map every 15 seconds
setInterval(()=>{
  if(!currentUser||currentUser.role!=='admin'||document.hidden) return;
  const p=document.querySelector('.a-panel.on');
  if(p&&p.id==='ap-deliveries'&&delivMap) refreshDeliveries(false);
},15000);

/* CUSTOMERS */
function buildCustomers(){
  const loyal=CUSTOMERS_DATA.filter(c=>c.seg==='Loyal');
  const occ=CUSTOMERS_DATA.filter(c=>c.seg==='Occasional');
  const nw=CUSTOMERS_DATA.filter(c=>c.seg==='New');
  document.getElementById('ap-customers').innerHTML=`<div class="a-title">Customer Analysis</div>
    <div class="seg-grid">
      <div class="seg-card"><div class="seg-num" style="color:#C2607E">${loyal.length}</div><div class="seg-lbl">Loyal Customers</div><div class="seg-rule">5 or more orders</div></div>
      <div class="seg-card"><div class="seg-num" style="color:#B8944A">${occ.length}</div><div class="seg-lbl">Occasional Buyers</div><div class="seg-rule">2 to 4 orders</div></div>
      <div class="seg-card"><div class="seg-num" style="color:#4F7EF7">${nw.length}</div><div class="seg-lbl">New Customers</div><div class="seg-rule">First order only</div></div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Customer List</h3><button class="btn-add" onclick="exportCustomersCSV()">Export CSV</button></div>
      <table class="a-table"><thead><tr><th>Name</th><th>Email</th><th>Total Orders</th><th>Total Spent</th><th>Segment</th><th>Actions</th></tr></thead>
      <tbody>${CUSTOMERS_DATA.map(c=>`
        <tr>
          <td style="font-weight:500">${c.name}</td>
          <td style="color:#64748B;font-size:12px">${c.email}</td>
          <td>${c.orders}</td>
          <td>${fmtPeso(c.total)}</td>
          <td><span class="badge ${c.seg==='Loyal'?'bg-green':c.seg==='Occasional'?'bg-amber':'bg-blue'}">${c.seg}</span></td>
          <td><button class="btn-edit" onclick="openEmailModal('${escJS(c.email)}','${escJS(c.name)}')">Email</button></td>
        </tr>`).join('')}
      </tbody></table></div>`;
}

/* PENDING APPROVALS */
async function buildApprovals(){
  const el=document.getElementById('ap-approvals');
  el.innerHTML=`<div class="a-title">Pending Approvals</div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Customer Signups Awaiting Approval</h3></div>
      <table class="a-table"><thead><tr><th>Name</th><th>Email</th><th>Signed Up</th><th>Actions</th></tr></thead>
      <tbody id="appr-tbody"><tr><td colspan="4" style="text-align:center;color:#64748B">Loading…</td></tr></tbody></table></div>`;
  let pending;
  try {
    pending = await apiFetch('/auth/pending-customers');
  } catch(e) { showToast('⚠️ '+e.message); document.getElementById('appr-tbody').innerHTML='<tr><td colspan="4" style="text-align:center;color:#64748B">Could not load pending approvals.</td></tr>'; return; }
  renderApprovalRows(pending);
}

function renderApprovalRows(pending){
  const tbody=document.getElementById('appr-tbody');
  if(!tbody) return;
  if(!pending.length){ tbody.innerHTML='<tr><td colspan="4" style="text-align:center;color:#64748B">No pending signups 🎉</td></tr>'; return; }
  tbody.innerHTML=pending.map(u=>`
    <tr id="appr-row-${u.id}">
      <td style="font-weight:500">${u.name}</td>
      <td style="color:#64748B;font-size:12px">${u.email}</td>
      <td style="color:#64748B;font-size:12px">${u.created_at?formatOrderDate(u.created_at):''}</td>
      <td><button class="btn-save-inline" onclick="approveCustomer(${u.id})">Approve</button><button class="btn-del" style="margin-left:4px" onclick="rejectCustomer(${u.id})">Reject</button></td>
    </tr>`).join('');
}

async function approveCustomer(id){
  try { await apiFetch('/auth/approve/'+id, { method:'POST' }); } catch(e){ showToast('⚠️ '+e.message); return; }
  document.getElementById('appr-row-'+id)?.remove();
  showToast('Customer approved.');
  buildApprovals();
}

async function rejectCustomer(id){
  if(!confirm('Reject this signup?')) return;
  try { await apiFetch('/auth/reject/'+id, { method:'POST' }); } catch(e){ showToast('⚠️ '+e.message); return; }
  document.getElementById('appr-row-'+id)?.remove();
  showToast('Signup rejected.');
  buildApprovals();
}

/* EXPIRY HELPERS
   Dates come from the API as 'YYYY-MM-DD'. They're parsed as LOCAL dates (not
   new Date('YYYY-MM-DD'), which is UTC and can be off by a day in the Philippines).
   A product counts as expired the day AFTER its expiry date. "Near expiry" = within 30 days. */
const NEAR_EXPIRY_DAYS = 30;
function parseLocalDate(str){
  if(!str) return null;
  const [y,m,d]=String(str).slice(0,10).split('-').map(Number);
  return (y&&m&&d) ? new Date(y,m-1,d) : null;
}
function fmtDate(str){
  const d=parseLocalDate(str);
  return d ? d.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'}) : '';
}
function expiryInfo(p){
  const end=parseLocalDate(p.exp);
  if(!end) return {state:'none',days:null};
  const today=new Date(); today.setHours(0,0,0,0);
  const days=Math.round((end-today)/86400000);
  if(days<0) return {state:'expired',days};
  if(days<=NEAR_EXPIRY_DAYS) return {state:'near',days};
  return {state:'fresh',days};
}
function expiryBadge(p){
  const x=expiryInfo(p);
  const dateLine=p.exp?`<div style="font-size:10px;color:#94A3B8;margin-top:3px">Exp ${fmtDate(p.exp)}</div>`:'';
  if(x.state==='none')    return '<span class="badge bg-gray">No date</span>';
  if(x.state==='expired') return `<span class="badge bg-red">✕ Expired</span>${dateLine}`;
  if(x.state==='near')    return `<span class="badge bg-amber">⚠ ${x.days===0?'Expires today':x.days+'d left'}</span>${dateLine}`;
  return `<span class="badge bg-green">✓ Fresh</span>${dateLine}`;
}
function expiryStatusText(p){
  const x=expiryInfo(p);
  return x.state==='none'?'No date':x.state==='expired'?'Expired':x.state==='near'?'Near Expiry':'Fresh';
}

/* INVENTORY */
let invRiskOnly=false;
function toggleExpiryRisk(){
  invRiskOnly=!invRiskOnly;
  buildInventory();
}
function buildInventory(){
  const totalUnits=PRODUCTS.reduce((s,p)=>s+p.stock,0);
  const lowStock=PRODUCTS.filter(p=>p.stock<30&&p.stock>0);
  const outStock=PRODUCTS.filter(p=>p.stock===0);
  const nearExp=PRODUCTS.filter(p=>expiryInfo(p).state==='near');
  const expired=PRODUCTS.filter(p=>expiryInfo(p).state==='expired');
  document.getElementById('ap-inventory').innerHTML=`<div class="a-title">Inventory Management</div>
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Total Products</div><div class="kpi-val">${PRODUCTS.length}</div></div>
      <div class="kpi"><div class="kpi-label">Low Stock</div><div class="kpi-val dn">${lowStock.length}</div></div>
      <div class="kpi"><div class="kpi-label">Out of Stock</div><div class="kpi-val dn">${outStock.length}</div></div>
      <div class="kpi"><div class="kpi-label">Total Units</div><div class="kpi-val">${totalUnits.toLocaleString()}</div></div>
      <div class="kpi"><div class="kpi-label">⚠️ Near Expiry (≤${NEAR_EXPIRY_DAYS}d)</div><div class="kpi-val dn">${nearExp.length}</div></div>
      <div class="kpi"><div class="kpi-label">⛔ Expired</div><div class="kpi-val dn">${expired.length}</div></div>
    </div>
    ${lowStock.length||outStock.length?`<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#B91C1C;font-weight:500">⚠️ ${lowStock.length} products are low on stock and ${outStock.length} are out of stock. Please reorder.</div>`:''}
    ${expired.length||nearExp.length?`<div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#B91C1C;font-weight:500">⛔ ${expired.length} product(s) have already expired and ${nearExp.length} are expiring within ${NEAR_EXPIRY_DAYS} days. Review stock before restocking or promoting these items.</div>`:''}
    <div class="a-card" style="margin-bottom:16px">
      <div class="a-card-head"><div><h3>📧 Expiry Alert Emails</h3>
        <div style="font-size:11.5px;color:#64748B;margin-top:3px">Sent automatically, so you don't need to press anything. These addresses get an email when a product is within ${NEAR_EXPIRY_DAYS} days of expiring and again when it has expired. Each product is reported once.</div></div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input id="inv-alert-emails" placeholder="you@gmail.com, manager@gmail.com" style="flex:1;min-width:240px;border:1.5px solid #E2E8F0;border-radius:8px;padding:9px 12px;font-size:13px;font-family:'DM Sans',sans-serif">
        <button class="btn-save-inline" onclick="saveAlertEmails()">Save</button>
      </div>
      <div id="inv-alert-status" style="font-size:11.5px;color:#64748B;margin-top:8px">Loading…</div>
    </div>
    <div class="tbl-wrap"><div class="tbl-head"><h3>Stock Levels</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn-risk${invRiskOnly?' on':''}" onclick="toggleExpiryRisk()">${invRiskOnly?'Show All Products':'⚠️ Show Expiry Risk Only'}</button>
        <button class="btn-add" onclick="exportInventoryCSV()">Export CSV</button>
      </div></div>
      <table class="a-table"><thead><tr><th>Product</th><th>Category</th><th>Current Stock</th><th>Level</th><th>Status</th><th>Expiry</th><th>Reorder Qty</th><th>Action</th></tr></thead>
      <tbody id="inv-tbody">${renderInvRows()}</tbody></table></div>`;
  loadAlertSettings();
}

/* ═══ EXPIRY ALERT EMAILS ═══
   The admin chooses who receives them (up to 5 addresses; empty = the admin's own login
   email). The server decides what is new and sends it, so each product is reported once. */
const ALERT_EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function loadAlertSettings(){
  const input=document.getElementById('inv-alert-emails'), status=document.getElementById('inv-alert-status');
  if(!input||!status) return;
  try {
    const st=await apiFetch('/inventory/alert-settings');
    input.value=(st.emails||[]).join(', ');
    input.placeholder=st.default_email?'Empty = your admin email ('+st.default_email+')':'you@gmail.com, manager@gmail.com';
    const sent=st.last_sent_at?new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(st.last_sent_at)?st.last_sent_at:st.last_sent_at+'Z'):null;
    const fmtWhen=iso=>new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso)?iso:iso+'Z').toLocaleString('en-PH',{month:'short',day:'numeric',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const lastText=(sent?'Last alert sent: '+fmtWhen(st.last_sent_at):'No alert has been sent yet.')
      +(st.last_checked_at?' · Last automatic check: '+fmtWhen(st.last_checked_at):'');
    const toText=(st.emails&&st.emails.length)?'Alerts go to: '+st.emails.join(', '):'No address saved yet, so alerts go to your admin email ('+st.default_email+').';
    status.textContent=toText+' · '+lastText;
  } catch(e){ status.textContent='Could not load the alert settings: '+e.message; }
}

async function saveAlertEmails(){
  const raw=document.getElementById('inv-alert-emails').value;
  const emails=raw.split(/[,;\s]+/).map(e=>e.trim().toLowerCase()).filter(Boolean);
  const bad=emails.find(e=>!ALERT_EMAIL_RE.test(e));
  if(bad){ showToast('⚠️ "'+bad+'" is not a valid email address.'); return; }
  try {
    await apiFetch('/inventory/alert-settings',{ method:'PUT', body: JSON.stringify({ emails }) });
  } catch(e){ showToast('⚠️ '+e.message); return; }
  showToast(emails.length?'✅ Alert emails saved.':'✅ Saved. Alerts will go to your admin email.');
  loadAlertSettings();
}

/* Runs quietly when the admin logs in or opens Inventory: emails only what has not been reported yet */
async function checkExpiryAlerts(){
  try {
    const r=await apiFetch('/inventory/expiry-alerts/send',{ method:'POST', body: JSON.stringify({ force:false }) });
    if(r.sent){
      showToast('📧 Expiry alert emailed to '+r.recipients.join(', ')+' ('+r.expired+' expired, '+r.near+' near expiry).');
      loadAlertSettings();
    } else if(r.reason==='send_failed'){
      console.warn('Expiry alert could not be emailed. Check the email service (Brevo).');
    }
  } catch(e){ console.warn('Expiry alert check failed:',e.message); }
}

function renderInvRows(){
  const list=invRiskOnly?PRODUCTS.filter(p=>['near','expired'].includes(expiryInfo(p).state)):PRODUCTS;
  if(!list.length) return `<tr><td colspan="8" style="text-align:center;padding:28px;color:#64748B">No products are expired or near expiry. 🎉</td></tr>`;
  return list.map(p=>{
    const color=p.stock===0?'#DC2626':p.stock<30?'#D97706':'#16A34A';
    const pct=Math.min(Math.round(p.stock/200*100),100);
    return`<tr id="inv-row-${p.id}">
      <td><span style="font-size:15px;margin-right:7px">${p.e}</span><span style="font-weight:500">${p.name}</span></td>
      <td>${p.cat}</td>
      <td><input type="number" value="${p.stock}" id="inv-qty-${p.id}" style="width:65px;border:1px solid #E2E8F0;border-radius:6px;padding:4px 7px;font-size:12px;font-family:'DM Sans',sans-serif"></td>
      <td style="min-width:90px"><div class="inv-bar-wrap"><div class="inv-bar" style="width:${pct}%;background:${color}"></div></div></td>
      <td><span class="badge ${p.stock===0?'bg-red':p.stock<30?'bg-amber':'bg-green'}">${p.stock===0?'Out of Stock':p.stock<30?'Low Stock':'In Stock'}</span></td>
      <td>${expiryBadge(p)}</td>
      <td>${p.stock<30?`<input type="number" value="100" id="inv-reorder-${p.id}" style="width:60px;border:1px solid #E2E8F0;border-radius:6px;padding:4px 7px;font-size:12px;font-family:'DM Sans',sans-serif">`:'—'}</td>
      <td>
        <button class="btn-save-inline" onclick="updateStock(${p.id})">Update</button>
        ${p.stock<30?`<button class="btn-edit" style="margin-left:4px" onclick="reorderStock(${p.id})">Reorder</button>`:''}
      </td>
    </tr>`;}).join('');
}

async function updateStock(id){
  const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
  const newQty=parseInt(document.getElementById('inv-qty-'+id).value);
  if(isNaN(newQty)||newQty<0){showToast('Invalid quantity.');return;}
  try {
    await apiFetch('/products/'+id, { method:'PUT', body: JSON.stringify({ stock: newQty }) });
    await loadProducts();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  document.getElementById('inv-tbody').innerHTML=renderInvRows();
  showToast('Stock updated for '+p.name);
}

async function reorderStock(id){
  const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
  const qty=parseInt(document.getElementById('inv-reorder-'+id)?.value)||100;
  try {
    await apiFetch('/products/'+id, { method:'PUT', body: JSON.stringify({ stock: p.stock + qty }) });
    await loadProducts();
  } catch(e){ showToast('⚠️ '+e.message); return; }
  document.getElementById('inv-tbody').innerHTML=renderInvRows();
  showToast('Reordered '+qty+' units of '+p.name);
}

/* ═══ REVIEW ═══
   Unlocked once the order is Delivered (set by the rider or the admin). The customer picks
   stars, writes a comment, optionally adds
   up to 3 photos, then presses Submit -> POST /orders/:id/review. The backend also
   updates each product's star rating, so we reload orders + products afterwards. */
const REVIEW_MAX_IMAGES = 3;
let pendingReviewImages = {};   // orderId -> [dataUrl,...] (kept across re-renders)
let pendingReviewStars  = {};   // orderId -> 1..5

function escHtml(t){
  return String(t==null?'':t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function reviewBlockHtml(o){
  const done=o.review;
  if(done){
    return `<div class="review-prompt">
      <div class="review-done-card">
        <div class="review-done" style="display:block">✅ Review submitted! Thank you!</div>
        <div class="rev-done-stars">${[1,2,3,4,5].map(i=>`<span class="rev-star${i<=done.rating?' on':''}">${i<=done.rating?'★':'☆'}</span>`).join('')}</div>
        ${done.text?`<div class="rev-done-text">${escHtml(done.text)}</div>`:''}
        ${(done.images&&done.images.length)?`<div class="rev-prev">${done.images.map(src=>`<div class="rev-thumb"><img src="${src}" alt="Review photo"></div>`).join('')}</div>`:''}
      </div>
    </div>`;
  }
  const cur=pendingReviewStars[o.id]||0;
  return `<div class="review-prompt">
    <div style="font-size:12px;font-weight:600;color:var(--dark);margin-bottom:8px">Rate your order ⭐</div>
    <div class="review-stars-row" id="revrow-${o.id}">${[1,2,3,4,5].map(i=>`<span class="rev-star${i<=cur?' on selected':''}" onclick="selectReviewStar('${o.id}',${i})">${i<=cur?'★':'☆'}</span>`).join('')}</div>
    <textarea class="review-input" id="rev-txt-${o.id}" placeholder="Share your experience..."></textarea>
    <div class="rev-prev" id="rev-prev-${o.id}">${reviewPreviewHtml(o.id)}</div>
    <div class="rev-actions">
      <label class="rev-addimg" id="rev-addimg-${o.id}"${(pendingReviewImages[o.id]||[]).length>=REVIEW_MAX_IMAGES?' style="display:none"':''}>
        📷 Add image
        <input type="file" accept="image/*" multiple style="display:none" onchange="addReviewImages('${o.id}',this)">
      </label>
      <button class="review-submit" onclick="submitReview('${o.id}')">Submit Review</button>
    </div>
  </div>`;
}

function reviewPreviewHtml(oid){
  return (pendingReviewImages[oid]||[]).map((src,i)=>`<div class="rev-thumb"><img src="${src}" alt="Review photo"><button type="button" class="rev-thumb-x" title="Remove" onclick="removeReviewImage('${oid}',${i})">×</button></div>`).join('');
}
function refreshReviewPreview(oid){
  const box=document.getElementById('rev-prev-'+oid);
  if(box) box.innerHTML=reviewPreviewHtml(oid);
  const btn=document.getElementById('rev-addimg-'+oid);
  if(btn) btn.style.display=(pendingReviewImages[oid]||[]).length>=REVIEW_MAX_IMAGES?'none':'';
}

/* Shrinks a photo to max 900px JPEG so it's light enough to store/send */
function compressImageFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error('Could not read image'));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error('Not a valid image'));
      img.onload=()=>{
        const max=900, scale=Math.min(1,max/Math.max(img.width,img.height));
        const c=document.createElement('canvas');
        c.width=Math.round(img.width*scale); c.height=Math.round(img.height*scale);
        c.getContext('2d').drawImage(img,0,0,c.width,c.height);
        resolve(c.toDataURL('image/jpeg',0.75));
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addReviewImages(oid,input){
  const files=[...(input.files||[])];
  input.value='';
  if(!files.length)return;
  const list=pendingReviewImages[oid]=pendingReviewImages[oid]||[];
  for(const f of files){
    if(list.length>=REVIEW_MAX_IMAGES){showToast('You can add up to '+REVIEW_MAX_IMAGES+' photos.');break;}
    if(!f.type.startsWith('image/')){showToast('Please choose an image file.');continue;}
    try{ list.push(await compressImageFile(f)); }
    catch(e){ showToast('⚠️ '+e.message); }
  }
  refreshReviewPreview(oid);
}
function removeReviewImage(oid,idx){
  (pendingReviewImages[oid]||[]).splice(idx,1);
  refreshReviewPreview(oid);
}

function selectReviewStar(oid,n){
  pendingReviewStars[oid]=n;
  document.querySelectorAll('#revrow-'+oid+' .rev-star').forEach((s,i)=>{
    s.textContent=i<n?'★':'☆';
    s.classList.toggle('on',i<n);
    s.classList.toggle('selected',i<n);
  });
}

async function submitReview(oid){
  const order=myOrders.find(o=>o.id===oid);
  if(!order)return;
  if(order.status!=='Delivered'){
    showToast('You can review this order once it has been delivered.');return;
  }
  const rating=pendingReviewStars[oid]||0;
  if(rating===0){showToast('Please select a star rating first.');return;}
  const text=(document.getElementById('rev-txt-'+oid)?.value||'').trim();
  const images=(pendingReviewImages[oid]||[]).slice();

  const btn=document.querySelector('#revrow-'+oid)?.closest('.review-prompt')?.querySelector('.review-submit');
  if(btn){btn.disabled=true;btn.textContent='Submitting...';}
  try {
    await apiFetch('/orders/'+order.dbId+'/review',{method:'POST',body:JSON.stringify({stars:rating,comment:text,images})});
  } catch(e){
    showToast('⚠️ '+e.message);
    if(btn){btn.disabled=false;btn.textContent='Submit Review';}
    return;
  }
  delete pendingReviewImages[oid]; delete pendingReviewStars[oid];
  showToast('⭐ Thank you for your review!');
  try { await Promise.all([loadOrders(), loadProducts()]); } catch(e){}
  renderOrders();
  if(typeof renderProducts==='function') renderProducts();
}

/* ═══ TRACK MY RIDER (customer) ═══
   An order that is For Delivery shows a live map right inside its card on My Orders: where the
   rider is, the customer's address, how far away they are, and the rider's name and phone number.
   "Open larger map" shows the same thing in a pop-up. Both refresh every 15 seconds, and the
   card updates by itself when the rider marks the order delivered. */
let trackMap=null, trackLayer=null, trackTimer=null, trackState={fitted:false};
let inlineTracks={}, inlineTrackTimer=null;          // order id -> {map, layer, state, statusEl}

/* Draws one tracking result onto a map and writes the plain-language status line above it */
function renderTrackResult(t,map,layer,statusEl,state){
  layer.clearLayers();
  if(!t.active){ statusEl.textContent='This order is no longer out for delivery.'; return; }
  const pts=[];
  if(t.dest){
    L.marker([t.dest.lat,t.dest.lng],{icon:dvIcon('🏠','#C2607E',true)}).addTo(layer).bindTooltip('Your delivery address');
    pts.push([t.dest.lat,t.dest.lng]);
  }
  const r=t.rider;
  if(r&&r.lat!=null){
    L.marker([r.lat,r.lng],{icon:dvTruckIcon(),zIndexOffset:1000}).addTo(layer).bindTooltip(escHtml(r.name));
    pts.push([r.lat,r.lng]);
  }
  // the rider's phone number, as a tap-to-call link
  const call=(r&&r.phone)?' <a class="trk-call" href="tel:'+String(r.phone).replace(/[^0-9+]/g,'')+'">📞 '+escHtml(r.phone)+'</a>':'';
  if(r&&r.lat!=null){
    const away=t.dest?haversineKm([r.lat,r.lng],[t.dest.lat,t.dest.lng]):null;
    const dist=away!=null?' About '+(away<1?Math.round(away*1000)+' m':away.toFixed(1)+' km')+' away in a straight line.':'';
    statusEl.innerHTML=(r.fresh
      ?'🚚 <b>'+escHtml(r.name)+'</b> is on the way with your order. Location updated '+timeAgo(r.updated_at)+'.'
      :'🚚 <b>'+escHtml(r.name)+'</b> has your order. Their location was last updated '+timeAgo(r.updated_at)+', so it may be out of date.')+dist+call;
  } else if(r){
    statusEl.innerHTML='🚚 <b>'+escHtml(r.name)+'</b> has your order. Their location will show here once they start sharing it.'+call;
  } else {
    statusEl.textContent='Your order is For Delivery. A rider will be assigned shortly, and their name, phone and location will show here.';
  }
  if(pts.length&&(!state.fitted||pts.length>1)){
    if(pts.length===1) map.setView(pts[0],15); else map.fitBounds(pts,{padding:[50,50],maxZoom:16});
    state.fitted=state.fitted||pts.length>1;
  }
}

/* ── pop-up version ── */
async function openTrackModal(orderDbId,orderNo){
  document.getElementById('track-title').textContent='Track '+orderNo;
  document.getElementById('track-status').textContent='Looking for your rider…';
  document.getElementById('track-modal-bg').classList.add('open');
  clearInterval(trackTimer);
  if(trackMap){ try{ trackMap.remove(); }catch(e){} trackMap=null; trackLayer=null; }
  if(typeof L==='undefined'){
    document.getElementById('track-map').innerHTML='<div style="padding:60px 20px;text-align:center;color:#64748B">The map could not load. Check your internet connection.</div>';
    return;
  }
  document.getElementById('track-map').innerHTML='';
  trackMap=L.map('track-map').setView(CDO_CENTER,12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(trackMap);
  trackLayer=L.layerGroup().addTo(trackMap);
  trackState={fitted:false};
  setTimeout(()=>{ if(trackMap) trackMap.invalidateSize(); },300);
  await refreshTrack(orderDbId);
  trackTimer=setInterval(()=>refreshTrack(orderDbId),15000);
}
function closeTrackModal(){
  clearInterval(trackTimer);
  document.getElementById('track-modal-bg').classList.remove('open');
  if(trackMap){ try{ trackMap.remove(); }catch(e){} trackMap=null; trackLayer=null; }
}
async function refreshTrack(orderDbId){
  const statusEl=document.getElementById('track-status');
  let t;
  try { t=await apiFetch('/delivery/track/'+orderDbId); }
  catch(e){ statusEl.textContent='⚠️ Could not load the rider location: '+e.message; return; }
  if(!trackMap||!trackLayer) return;
  renderTrackResult(t,trackMap,trackLayer,statusEl,trackState);
}

/* ── map inside the order card ── */
function disposeInlineTracks(){
  clearInterval(inlineTrackTimer); inlineTrackTimer=null;
  Object.values(inlineTracks).forEach(x=>{ try{ x.map.remove(); }catch(e){} });
  inlineTracks={};
}
/* Called after the order list is drawn: gives every For Delivery order card its own live map */
function initInlineTracks(){
  disposeInlineTracks();
  if(typeof L==='undefined') return;
  const page=document.getElementById('cpage-orders');
  if(!page||!page.classList.contains('active')) return;          // only while My Orders is on screen
  const boxes=[...document.querySelectorAll('[data-itrack]')];
  if(!boxes.length) return;
  boxes.forEach(box=>{
    const id=box.getAttribute('data-itrack');
    const mobile=!!(L.Browser&&L.Browser.mobile);
    // scroll-wheel zoom off, and one-finger drag off on phones, so the map never traps page scrolling
    const map=L.map(box.querySelector('.itrack-map'),{scrollWheelZoom:false,dragging:!mobile}).setView(CDO_CENTER,12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
    inlineTracks[id]={map,layer:L.layerGroup().addTo(map),state:{fitted:false},statusEl:box.querySelector('.itrack-status')};
    setTimeout(()=>{ try{ map.invalidateSize(); }catch(e){} },250);
  });
  refreshInlineTracks();
  inlineTrackTimer=setInterval(refreshInlineTracks,15000);
}
async function refreshInlineTracks(){
  if(!currentUser||document.hidden) return;
  const page=document.getElementById('cpage-orders');
  if(!page||!page.classList.contains('active')) return;
  for(const id of Object.keys(inlineTracks)){
    const x=inlineTracks[id]; if(!x) continue;
    let t;
    try { t=await apiFetch('/delivery/track/'+id); }
    catch(e){ x.statusEl.textContent='⚠️ Could not load the rider location right now.'; continue; }
    if(!inlineTracks[id]) continue;                              // the card was redrawn while waiting
    renderTrackResult(t,x.map,x.layer,x.statusEl,x.state);
    if(!t.active){                                               // delivered: refresh the list so the card updates by itself
      loadOrders().then(()=>renderOrders()).catch(()=>{});
      return;
    }
  }
}

/* ═══ MY STATS ═══ */
function renderStats(){
  const body=document.getElementById('stats-body');
  if(!body)return;
  const totalSpent=myOrders.reduce((s,o)=>s+o.total,0);
  const cats={};
  myOrders.forEach(o=>{
    const names=o.items.split(',');
    names.forEach(nm=>{
      const p=PRODUCTS.find(x=>x.name===nm.trim());
      if(p)cats[p.cat]=(cats[p.cat]||0)+p.price;
    });
  });
  body.innerHTML=`
    <div class="stats-kpi">
      <div class="sk"><div class="sk-icon">💰</div><div class="sk-lbl">Total Spent</div><div class="sk-val">₱${totalSpent.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>
      <div class="sk"><div class="sk-icon">📦</div><div class="sk-lbl">Total Orders</div><div class="sk-val">${myOrders.length}</div></div>
      <div class="sk"><div class="sk-icon">⭐</div><div class="sk-lbl">Loyalty Points</div><div class="sk-val">${loyaltyPoints}</div></div>
    </div>
    <div class="stats-charts">
      <div class="sc"><h3>Spending by Category</h3><div style="position:relative;height:180px"><canvas id="ch-cust-cat"></canvas></div></div>
      <div class="sc"><h3>Order History</h3><div style="position:relative;height:180px"><canvas id="ch-cust-ord"></canvas></div></div>
    </div>
    ${myOrders.length===0?`<div class="empty-state"><div class="empty-icon">📊</div><h3>No data yet</h3><p>Place your first order to see your spending analytics here!</p><button onclick="cPage('shop',document.getElementById('cnav-shop'))">Start Shopping →</button></div>`:''}
  `;
  if(myOrders.length>0){
    const catLabels=Object.keys(cats);
    const catVals=catLabels.map(k=>parseFloat(cats[k].toFixed(2)));
    new Chart(document.getElementById('ch-cust-cat'),{type:'doughnut',data:{labels:catLabels,datasets:[{data:catVals,backgroundColor:['#C2607E','#B8944A','#4A8C5C','#4F7EF7','#A03030'],borderWidth:0,hoverOffset:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{font:{size:11}}}}}});
    const ordLabels=myOrders.slice().reverse().map(o=>o.id);
    const ordVals=myOrders.slice().reverse().map(o=>o.total);
    new Chart(document.getElementById('ch-cust-ord'),{type:'bar',data:{labels:ordLabels,datasets:[{data:ordVals,backgroundColor:'rgba(194,96,126,0.75)',borderRadius:6,label:'₱'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{ticks:{callback:v=>'₱'+v.toLocaleString()},grid:{color:'#F1F5F9'}}}}});
  }
}


/* ═══ MEGA MENU ═══ */
function setCat(cat){
  activeCat=cat;
  cPage('shop',document.getElementById('cnav-shop'));
  // update category strip
  document.querySelectorAll('.cat-strip-item').forEach(el=>{
    el.classList.toggle('on',el.textContent.trim()===cat||el.dataset.cat===cat);
  });
  renderProducts();
  document.getElementById('section-title').textContent=cat;
}
function filterBadge(badge){
   const onShop = document.getElementById('cpage-shop')?.classList.contains('active');
  if(!onShop){ cPage('shop',document.getElementById('cnav-shop')); }
  activeCat='All';
  document.querySelectorAll('.cat-strip-item').forEach(el=>el.classList.remove('on'));
  const grid=document.getElementById('products-grid');
  const q='';
  const list=PRODUCTS.filter(p=>p.badge===badge);
  if(!list.length){grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:64px;color:var(--v-muted)"><div style="font-size:44px;margin-bottom:12px">'+(badge==='hot'?'🔥':'✨')+'</div><p>No products found.</p></div>';return;}
  grid.innerHTML=list.map(p=>{
    const inWL=wishlist.includes(p.id);
    const r=productRatings[p.id];
    const starsHtml=r?[1,2,3,4,5].map(i=>`<span class="s${i<=Math.round(parseFloat(r.avg))?' on':''}">${i<=Math.round(parseFloat(r.avg))?'★':'☆'}</span>`).join('')+'<span class="p-rating-txt">('+r.count+')</span>':'';
    const badgeHtml=p.badge==='hot'?'<span class="p-badge">🔥 Hot</span>':p.badge==='new'?'<span class="p-badge new">✨ New</span>':'';
    return`<div class="p-card${isExpired(p)?' expired':''}" onclick="openProductModal(${p.id})">${isExpired(p)?'<span class="p-badge" style="background:#B91C1C">⛔ Expired</span>':badgeHtml}<div class="p-img">${productImgHtml(p)}<button class="p-wishlist" onclick="event.stopPropagation();toggleWishlist(${p.id})">${inWL?'❤️':'♡'}</button></div><div class="p-info">${r?`<div class="p-stars-row">${starsHtml}</div>`:''}<div class="p-name">${p.name}</div><div class="p-cat">${p.cat}</div><div class="p-price-row"><div class="p-price">${priceHtml(p)}</div></div><div class="p-stock ${p.stock===0?'low':''}">${p.stock===0?'Out of stock':p.stock+' in stock'}</div><button class="p-add" onclick="event.stopPropagation();addCart(${p.id})" ${p.stock===0||isExpired(p)?'disabled':''}>${isExpired(p)?'Expired':'🛒 Add to Cart'}</button></div></div>`;
  }).join('');
  document.getElementById('section-title').textContent=badge==='hot'?'🔥 Best Sellers':'✨ New Arrivals';
}
function triggerFlashSale(){
  const onShop = document.getElementById('cpage-shop')?.classList.contains('active');
  if(!onShop){ cPage('shop',document.getElementById('cnav-shop')); }
  activeCat='All';
  // Only products the admin has put on sale, biggest discount first
  const list=PRODUCTS.filter(saleActive).sort((a,b)=>salePct(b)-salePct(a));
  const grid=document.getElementById('products-grid');
  document.getElementById('section-title').textContent='⚡ Flash Sale';
  if(!list.length){
    grid.innerHTML='<div style="grid-column:1/-1;text-align:center;padding:64px;color:var(--v-muted)"><div style="font-size:44px;margin-bottom:12px">🏷️</div><p>No items are on sale right now. Check back soon!</p></div>';
    return;
  }
  grid.innerHTML=list.map(p=>{
    const inWL=wishlist.includes(p.id);
    const r=productRatings[p.id];
    const starsHtml=r?[1,2,3,4,5].map(i=>`<span class="s${i<=Math.round(parseFloat(r.avg))?' on':''}">${i<=Math.round(parseFloat(r.avg))?'★':'☆'}</span>`).join('')+'<span class="p-rating-txt">('+r.count+')</span>':'';
    const expired=isExpired(p);
    return`<div class="p-card${expired?' expired':''}" style="border:2px solid #D4A853" onclick="openProductModal(${p.id})"><span class="p-badge" style="background:${expired?'#B91C1C':'#D4A853'}">${expired?'⛔ Expired':'⚡ Sale −'+salePct(p)+'%'}</span><div class="p-img">${productImgHtml(p)}<button class="p-wishlist" onclick="event.stopPropagation();toggleWishlist(${p.id})">${inWL?'❤️':'♡'}</button></div><div class="p-info">${r?`<div class="p-stars-row">${starsHtml}</div>`:''}<div class="p-name">${p.name}</div><div class="p-cat">${p.cat}</div><div class="p-price-row"><div class="p-price">${priceHtml(p)}</div></div><div class="p-stock ${p.stock===0?'low':''}">${p.stock===0?'Out of stock':p.stock+' in stock'}</div><button class="p-add" onclick="event.stopPropagation();addCart(${p.id})" ${p.stock===0||expired?'disabled':''}>${expired?'Expired':'🛒 Add to Cart'}</button></div></div>`;
  }).join('');
}
function setCatAll(){
  activeCat='All';
  document.querySelectorAll('.cat-strip-item').forEach(el=>el.classList.remove('on'));
  if(document.querySelector('.cat-strip-item'))document.querySelector('.cat-strip-item').classList.add('on');
  renderProducts();
  document.getElementById('section-title').textContent='All Products';
}
/* ═══ MEGA MENU — robust hover with 220ms close-delay ═══ */
(function(){
  const DELAY = 220; // ms grace period for cursor to travel into panel

  let closeTimer = null;
  let currentOpen = null;

  function openMenu(item) {
    // cancel any pending close
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }

    // close previously open item (if different)
    if (currentOpen && currentOpen !== item) {
      currentOpen.classList.remove('open');
      const oldPanel = currentOpen.querySelector('.mega-panel');
      if (oldPanel) oldPanel.classList.remove('open');
    }

    currentOpen = item;
    item.classList.add('open');
    const panel = item.querySelector('.mega-panel');
    if (panel) panel.classList.add('open');
    document.getElementById('mega-overlay').classList.add('on');
  }

  function scheduleClose(item) {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(function() {
      // Only close if the cursor isn't inside the item or its panel right now
      if (currentOpen === item) {
        item.classList.remove('open');
        const panel = item.querySelector('.mega-panel');
        if (panel) panel.classList.remove('open');
        currentOpen = null;
        document.getElementById('mega-overlay').classList.remove('on');
      }
      closeTimer = null;
    }, DELAY);
  }

  function cancelClose() {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }

  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.mn-item').forEach(function(item) {
      const panel = item.querySelector('.mega-panel');

      // trigger open on nav button hover
      item.addEventListener('mouseenter', function() { openMenu(item); });

      // start close timer when leaving the nav item wrapper
      item.addEventListener('mouseleave', function(e) {
        // if moving into the panel itself, don't close
        const to = e.relatedTarget;
        if (panel && panel.contains(to)) { cancelClose(); return; }
        scheduleClose(item);
      });

      // keep open while inside the panel
      if (panel) {
        panel.addEventListener('mouseenter', function() { cancelClose(); });
        panel.addEventListener('mouseleave', function(e) {
          // if moving back to the nav item, don't close
          const to = e.relatedTarget;
          if (item.contains(to)) { cancelClose(); return; }
          scheduleClose(item);
        });
      }
    });

    // close on overlay click
    const overlay = document.getElementById('mega-overlay');
    if (overlay) overlay.addEventListener('click', function() {
      if (currentOpen) {
        currentOpen.classList.remove('open');
        const panel = currentOpen.querySelector('.mega-panel');
        if (panel) panel.classList.remove('open');
        currentOpen = null;
      }
      overlay.classList.remove('on');
    });

    // close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && currentOpen) {
        currentOpen.classList.remove('open');
        const panel = currentOpen.querySelector('.mega-panel');
        if (panel) panel.classList.remove('open');
        currentOpen = null;
        document.getElementById('mega-overlay').classList.remove('on');
      }
    });
  });
})();

function closeAllMega(){
  document.querySelectorAll('.mn-item').forEach(function(item){
    item.classList.remove('open');
    const panel = item.querySelector('.mega-panel');
    if(panel) panel.classList.remove('open');
  });
  document.getElementById('mega-overlay').classList.remove('on');
}

/* ═══ INFO MODALS (About, Contact, FAQ, Product Description/Ingredients/How to Use/Benefits) ═══ */
const INFO_MODAL_CONTENT = {
  description: {
    title: 'Product Description',
    body: `<p>GV Cosmetics offers a curated line of hair care and styling essentials — from styling gels and sprays to treatment products — crafted for everyday salon-quality results.</p>
           <p>Each product listing includes a full description with its intended use, key features, and net weight/volume. Open any product card in the shop to see its specific description.</p>`
  },
  ingredients: {
    title: 'Ingredients',
    body: `<p>Full ingredient lists are printed on each product's packaging and are also available on the individual product page in the shop.</p>
           <p>Our formulas are developed with salon professionals and are free from harsh sulfates where possible. If you have a specific allergy or sensitivity, please check the product packaging or contact our support team before use.</p>`
  },
  howtouse: {
    title: 'How to Use',
    body: `<ol style="padding-left:18px;line-height:1.9">
             <li>Start with clean, towel-dried or dry hair depending on the product type.</li>
             <li>Apply a small amount evenly, working from roots to ends (or as directed on the label).</li>
             <li>Style as desired with a comb, brush, or your fingers.</li>
             <li>For sprays, hold the can 20–30cm from hair and apply in short bursts.</li>
           </ol>
           <p>Always check the specific instructions on your product's packaging, as usage can vary between gels, sprays, and treatments.</p>`
  },
  benefits: {
    title: 'Benefits',
    body: `<ul style="padding-left:18px;line-height:1.9">
             <li>💇 Long-lasting hold and style control</li>
             <li>✨ Adds shine without weighing hair down</li>
             <li>🌿 Lightweight, non-greasy formulas</li>
             <li>💧 Easy to wash out with regular shampoo</li>
             <li>🏆 Trusted, salon-tested formulations</li>
           </ul>`
  },
  about: {
    title: 'About Us',
    body: `<p>GV Cosmetics is a hair care and styling brand based in Cagayan de Oro, proudly serving customers with quality, affordable products for every hair type and style.</p>
           <p>What started as a small local supplier has grown into a trusted name for stylists and everyday customers alike, offering gels, sprays, treatments, and more — all backed by real customer reviews and ratings.</p>`
  },
  contact: {
    title: 'Contact Us',
    body: `<p>We'd love to hear from you! Reach us through any of the following:</p>
           <p>📍 Based in Cagayan de Oro, Philippines<br>
           🕘 Mon–Sat, 9:00 AM – 6:00 PM<br>
           📧 support@gvcosmetics.com<br>
           📞 (Add your business contact number here)</p>
           <p>You can also reach out through your account's order page for order-specific questions.</p>`
  },
  faq: {
    title: 'Frequently Asked Questions',
    body: `<p><strong>How long does delivery take?</strong><br>Delivery times vary by location; you can track your order status anytime from the "My Orders" page.</p>
           <p><strong>Can I change or cancel my order?</strong><br>Contact us as soon as possible after placing your order — changes can only be made before it ships.</p>
           <p><strong>How do I earn loyalty points?</strong><br>Loyalty points are automatically added to your account with every completed purchase.</p>
           <p><strong>What if a product arrives damaged?</strong><br>Please contact our support team with your order number and a photo of the item within 7 days of delivery.</p>`
  }
};

/* Escapes a value safely for embedding inside a single-quoted inline
   onclick="..." attribute (used when building HTML strings with customer
   data that could contain apostrophes, e.g. "O'Brien"). */
function escJS(s){
  return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'");
}

/* ═══ ADMIN CHANGE PASSWORD MODAL ═══ */
function openAdminPwdModal(){
  document.getElementById('admin-pwd-current').value='';
  document.getElementById('admin-pwd-new').value='';
  document.getElementById('admin-pwd-confirm').value='';
  document.getElementById('admin-pwd-strength').style.width='0';
  document.getElementById('admin-pwd-strength').style.background='#ccc';
  document.getElementById('admin-pwd-strength-label').textContent='';
  document.getElementById('admin-pwd-modal-bg').classList.add('open');
}
function closeAdminPwdModal(){
  document.getElementById('admin-pwd-modal-bg').classList.remove('open');
}
function checkAdminPwdStrength(){
  const v=document.getElementById('admin-pwd-new').value;
  const bar=document.getElementById('admin-pwd-strength');
  const lbl=document.getElementById('admin-pwd-strength-label');
  const pct=Math.min(v.length/10*100,100);
  const color=pct<40?'#C87941':pct<70?'#D97706':'#16A34A';
  const text=pct<40?'Weak':pct<70?'Moderate':'Strong';
  bar.style.width=pct+'%';bar.style.background=color;lbl.textContent=text;lbl.style.color=color;
}
async function submitAdminPasswordChange(){
  const cur=document.getElementById('admin-pwd-current').value;
  const nw=document.getElementById('admin-pwd-new').value;
  const cf=document.getElementById('admin-pwd-confirm').value;
  if(!cur){showToast('❌ Please enter your current password.');return;}
  if(nw.length<6){showToast('❌ New password must be at least 6 characters.');return;}
  if(nw!==cf){showToast('❌ Passwords do not match.');return;}

  const btn=document.querySelector('#admin-pwd-modal-bg .btn-do-verify');
  const originalText=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent='Updating...';}

  try {
    // Same endpoint the customer profile page uses — the backend enforces
    // the 1-capital + 1-special-character rule regardless of role, so a
    // weak password is rejected here too, with the server's own message.
    await apiFetch('/auth/change-password', { method:'POST', body: JSON.stringify({ current_password: cur, new_password: nw }) });
  } catch(e){
    showToast('❌ '+e.message);
    if(btn){btn.disabled=false;btn.textContent=originalText;}
    return;
  }

  closeAdminPwdModal();
  showToast('✅ Password updated successfully!');
}

/* ═══ EMAIL CUSTOMER MODAL (admin, Customer Analysis) ═══ */
function openEmailModal(email, name){
  const toEl = document.getElementById('email-modal-to');
  toEl.textContent = `To: ${name} <${email}>`;
  toEl.dataset.email = email;
  toEl.dataset.name = name;
  document.getElementById('email-subject-input').value = '';
  document.getElementById('email-message-input').value = '';
  document.getElementById('email-modal-bg').classList.add('open');
}
function closeEmailModal(){
  document.getElementById('email-modal-bg').classList.remove('open');
}
async function submitCustomerEmail(){
  const toEl = document.getElementById('email-modal-to');
  const email = toEl.dataset.email;
  const name = toEl.dataset.name;
  const subject = document.getElementById('email-subject-input').value.trim();
  const message = document.getElementById('email-message-input').value.trim();

  if(!subject || !message){
    showToast('⚠️ Please fill in both a subject and a message.');
    return;
  }

  const btn = document.querySelector('.email-modal .btn-do-verify');
  const originalText = btn ? btn.textContent : '';
  if(btn){ btn.disabled = true; btn.textContent = 'Sending...'; }

  try {
    await apiFetch(`/customers/${encodeURIComponent(email)}/email`, {
      method: 'POST',
      body: JSON.stringify({ subject, message })
    });
    closeEmailModal();
    showToast(`✅ Email sent to ${name}`);
  } catch(e) {
    showToast('⚠️ Could not send email: ' + e.message);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = originalText; }
  }
}

function openModal(key){
  const data = INFO_MODAL_CONTENT[key];
  if(!data) return;
  document.getElementById('im-title').textContent = data.title;
  document.getElementById('im-body').innerHTML = data.body;
  document.getElementById('info-modal-bg').classList.add('open');
}

function closeModal(e){
  // If triggered by clicking the background, only close when the background itself (not the modal box) was clicked
  if(e && e.target && e.target.id !== 'info-modal-bg' && e.type === 'click' && e.target.closest('#info-modal')) return;
  document.getElementById('info-modal-bg').classList.remove('open');
}

/* ═══ PRODUCT QUICK VIEW ═══ */
function openProductModal(id){
  const p=PRODUCTS.find(x=>x.id===id);if(!p)return;
  const inWL=wishlist.includes(p.id);
  const r=productRatings[p.id];
  const starsHtml=r?[1,2,3,4,5].map(i=>`<span class="s${i<=Math.round(parseFloat(r.avg))?' on':''}">${i<=Math.round(parseFloat(r.avg))?'★':'☆'}</span>`).join('')+' <span class="p-rating-txt">('+r.count+')</span>':'';
  const expired=isExpired(p);
  const stockClass=expired||p.stock===0?'out':p.stock<30?'low':'ok';
  const stockText=expired?'⛔ Expired — no longer available to order':p.stock===0?'Out of stock':p.stock<30?'⚠️ Only '+p.stock+' left in stock':p.stock+' in stock';
  document.getElementById('pm-body').innerHTML=`
    <div class="pm-img-wrap">${productImgHtml(p,120)}</div>
    <div class="pm-details">
      <div class="pm-cat">${p.cat}</div>
      <div class="pm-name">${p.name}</div>
      ${r?`<div class="pm-stars-row">${starsHtml}</div>`:''}
      <div class="pm-price">${priceHtml(p)}</div>
      <div class="pm-desc">${p.desc||'No description available.'}</div>
      <div class="pm-stock ${stockClass}">${stockText}</div>
      <div class="pm-actions">
        <button class="pm-add-btn" onclick="addCart(${p.id})" ${p.stock===0||expired?'disabled':''}>${expired?'Expired':p.stock===0?'Out of Stock':'🛒 Add to Cart'}</button>
        <button class="pm-wl-btn" onclick="toggleWishlist(${p.id});openProductModal(${p.id})">${inWL?'❤️':'♡'}</button>
      </div>
    </div>`;
  document.getElementById('pm-modal-bg').classList.add('open');
}

function closeProductModal(e){
  if(e && e.target && e.target.id !== 'pm-modal-bg' && e.type === 'click' && e.target.closest('#pm-modal')) return;
  document.getElementById('pm-modal-bg').classList.remove('open');
}

/* ═══ SESSION RESTORE (keeps you logged in across page refreshes) ═══ */
async function doLogin(){
  const email=document.getElementById('inp-email').value.trim().toLowerCase();
  const pass=document.getElementById('inp-pass').value;
  const err=document.getElementById('err-msg');

  let data;
  try {
    const form = new URLSearchParams();
    form.set('username', email);
    form.set('password', pass);
    data = await apiFetch('/auth/login', { method: 'POST', body: form });
  } catch (e) {
    err.style.display='block';
    return;
  }
  err.style.display='none';

  authToken = data.access_token;
  localStorage.setItem('gvci_token', authToken);
  const acc = data.user;
  currentUser = acc;
  loyaltyPoints = acc.loyalty_points || 0;
  displayName = acc.name;
  currentPass = pass;

  document.getElementById('screen-login').classList.add('hidden');
  if(acc.role==='customer'){
    document.getElementById('screen-customer').classList.remove('hidden');
    document.getElementById('c-avatar').textContent=acc.initials;
    document.getElementById('prof-avatar-big').textContent=acc.initials;
    document.getElementById('c-username').textContent=acc.name.split(' ')[0];
    applyProfileToUI(acc);
    await loadAllData([['products',loadProducts], ['wishlist',loadWishlist], ['orders',loadOrders], ['addresses',loadAddresses], ['notifications',loadNotifications]]);
    loadCartFromStorage();updatePill();buildShop();renderAddrList();buildRecommendations();updateWishlistBadge();updateNotifBell();renderWishlist();
  } else {
    document.getElementById('screen-admin').classList.remove('hidden');
    await loadAllData([['products',loadProducts], ['orders',loadOrders], ['customers',loadCustomers]]);
    buildAdminAll();
  }
}

/* ═══ PAYMENT REDIRECT (customer landing back here from PayMongo's checkout page) ═══ */
function handlePaymentRedirect(){
  const params = new URLSearchParams(window.location.search);
  const status = params.get('payment');
  const orderNum = params.get('order');
  if(!status) return;

  if(status==='success'){
    showToast('✅ Payment received for order ' + (orderNum||'') + '! We\'ll notify you as it\'s processed.');
    if(typeof loadOrders==='function') loadOrders().then(()=>{ if(typeof renderOrders==='function') renderOrders(); }).catch(()=>{});
  } else if(status==='cancelled'){
    showToast('⚠️ Payment was cancelled for order ' + (orderNum||'') + '. Your order is saved — you can retry payment from My Orders.');
  }

  // Strip the payment params so refreshing the page doesn't re-trigger this toast
  params.delete('payment');
  params.delete('order');
  const clean = window.location.pathname + (params.toString() ? '?' + params.toString() : '');
  window.history.replaceState({}, document.title, clean);
}

async function tryRestoreSession(){
  if(!authToken)return;
  let acc;
  try { acc = await apiFetch('/auth/me'); }
  catch(e){ authToken=null; localStorage.removeItem('gvci_token'); return; }

  currentUser = acc;
  loyaltyPoints = acc.loyalty_points || 0;
  displayName = acc.name;

  document.getElementById('screen-login').classList.add('hidden');
  if(acc.role==='customer'){
    document.getElementById('screen-customer').classList.remove('hidden');
    document.getElementById('c-avatar').textContent=acc.initials;
    document.getElementById('prof-avatar-big').textContent=acc.initials;
    document.getElementById('c-username').textContent=acc.name.split(' ')[0];
    applyProfileToUI(acc);
    await loadAllData([['products',loadProducts], ['wishlist',loadWishlist], ['orders',loadOrders], ['addresses',loadAddresses], ['notifications',loadNotifications]]);
    loadCartFromStorage();updatePill();buildShop();renderAddrList();buildRecommendations();updateWishlistBadge();updateNotifBell();renderWishlist();
  } else {
    document.getElementById('screen-admin').classList.remove('hidden');
    await loadAllData([['products',loadProducts], ['orders',loadOrders], ['customers',loadCustomers]]);
    buildAdminAll();
  }
}
tryRestoreSession().then(handlePaymentRedirect);
