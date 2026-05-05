# Configuración en VPS Hostinger con EasyPanel

## Requisitos previos

- VPS con EasyPanel instalado (Ubuntu 22.04 recomendado)
- Dominio o subdominio apuntando a la IP de tu VPS (ej: `wa.tu-dominio.com`)

---

## 1. Subir el código al VPS

Tienes dos opciones:

**Opción A — GitHub (recomendada)**
1. Crea un repositorio en GitHub con solo la carpeta `whatsapp-service/`
   (o usa el repositorio completo y configura el directorio raíz en EasyPanel)

**Opción B — Subida directa**
1. Comprime la carpeta `whatsapp-service/` (sin `node_modules/` ni `wa_session/`)
2. Súbela al VPS con `scp` o el gestor de archivos de Hostinger

---

## 2. Crear el servicio en EasyPanel

1. Abre EasyPanel → **Projects** → **+ New Project**
2. Nombre del proyecto: `zyton-wa`
3. Dentro del proyecto → **+ New Service** → elige **App**
4. Configura:
   - **Name:** `whatsapp-service`
   - **Source:** GitHub (conecta tu repo) o **Upload** si subiste el zip
   - **Root Directory:** `whatsapp-service` (si usas el repo completo)
   - **Build Method:** `nixpacks` (EasyPanel lo detecta automáticamente con el `package.json`)
   - **Start Command:** `node index.js`

---

## 3. Variables de entorno en EasyPanel

En la pestaña **Environment** del servicio, agrega:

| Variable | Valor |
|---|---|
| `PORT` | `3001` |
| `BRIDGE_TOKEN` | Un token largo y aleatorio (ej: genera con `openssl rand -hex 32`) |
| `SUPABASE_URL` | Tu URL de Supabase (ej: `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Tu service role key de Supabase |
| `NEXTJS_WEBHOOK_URL` | `https://tu-plataforma.vercel.app/api/whatsapp/webhook` |
| `NEXTJS_WEBHOOK_SECRET` | El mismo valor que `BRIDGE_TOKEN` |

---

## 4. Dominio y HTTPS en EasyPanel

1. Ve a la pestaña **Domains** del servicio
2. Agrega tu subdominio: `wa.tu-dominio.com`
3. EasyPanel gestiona el certificado SSL automáticamente con Let's Encrypt
4. El proxy reverso expone el puerto 3001 externamente en HTTPS

---

## 5. Variables de entorno en Vercel (Next.js)

En tu proyecto de Vercel → **Settings** → **Environment Variables**, agrega:

| Variable | Valor |
|---|---|
| `WA_BRIDGE_URL` | `https://wa.tu-dominio.com` |
| `WA_BRIDGE_TOKEN` | El mismo token que configuraste en EasyPanel |

---

## 6. Chromium / Puppeteer en el VPS

`whatsapp-web.js` usa Puppeteer (Chromium) internamente. EasyPanel ya incluye las dependencias del sistema necesarias en imágenes Nixpacks. Si ves errores de Chromium al arrancar, ejecuta en el terminal del VPS:

```bash
apt-get install -y \
  chromium-browser \
  libatk-bridge2.0-0 \
  libxss1 \
  libasound2 \
  libgbm1
```

Y asegúrate de que en `index.js` los args de Puppeteer incluyen `--no-sandbox` (ya están configurados).

---

## 7. Verificar que todo funciona

```bash
# Desde tu PC, probar el health check:
curl https://wa.tu-dominio.com/health
# Respuesta esperada: {"ok":true}

# Probar el estado (requiere el token):
curl -H "x-bridge-token: TU_TOKEN" https://wa.tu-dominio.com/status
# Respuesta esperada: {"status":"connecting","qr":"data:image/png;base64,...","phone":null}
```

Si el QR aparece, abre la plataforma en `/chat` y deberías ver el QR para escanear con WhatsApp.

---

## 8. Persistencia de sesión

EasyPanel monta un volumen persistente por defecto. La sesión de WhatsApp se guarda en `./wa_session/` dentro del contenedor. Configura un volumen en EasyPanel:

- **Pestaña Mounts** → **+ Add Mount**
- **Container Path:** `/app/wa_session`
- **Type:** Volume

Esto evita que tengas que escanear el QR cada vez que el servicio se reinicia.
