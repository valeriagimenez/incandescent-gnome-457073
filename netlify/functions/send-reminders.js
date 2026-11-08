// netlify/functions/send-reminders.js
// ---------------------------------------------------------------------------
// Módulo 6 — Web Push (lado servidor). Se ejecuta sola cada 15 minutos
// (configurado en netlify.toml) y:
//   1. Busca en Firestore (con Firebase Admin, sin restricción de reglas)
//      los ítems de agenda que vencen en la próxima hora, no están
//      completados y no se les avisó todavía.
//   2. Por cada uno, busca la suscripción push del dueño y le manda una
//      notificación con web-push (protocolo VAPID).
//   3. Marca el ítem como notificado para no repetir el aviso.
//
// ⚠️ ESTE ARCHIVO NECESITA CONFIGURACIÓN MANUAL ANTES DE FUNCIONAR:
//
// 1) Instala las dependencias (ya están en package.json):
//      npm install
//
// 2) Genera un par de claves VAPID (identifican a tu servidor ante los
//    navegadores). Puedes usar la CLI de web-push:
//      npx web-push generate-vapid-keys
//    Copia la "Public Key" en push.js (VAPID_PUBLIC_KEY) y define estas
//    variables de entorno en Netlify:
//      VAPID_PUBLIC_KEY
//      VAPID_PRIVATE_KEY
//      VAPID_SUBJECT           (ej. "mailto:tucorreo@dominio.com")
//
// 3) Genera una cuenta de servicio de Firebase (Firebase Console → ⚙️
//    Configuración del proyecto → Cuentas de servicio → Generar nueva
//    clave privada). Convierte el JSON descargado a Base64 en una línea:
//      base64 -w 0 tu-service-account.json     (Linux/Mac)
//      certutil -encode tu-service-account.json tmp.b64   (Windows, luego limpia cabeceras)
//    Define esa cadena como variable de entorno en Netlify:
//      FIREBASE_SERVICE_ACCOUNT_BASE64
//
// 4) La primera vez que corra, la consulta con múltiples filtros
//    (completed + dueAt + notifiedAt en una collectionGroup) probablemente
//    pida un índice compuesto: Firestore te da un error con un LINK directo
//    para crearlo con un clic. Ábrelo, crea el índice, y listo.
//
// Sin estas variables configuradas, la función se detiene temprano sin
// romper nada más del sitio (ver checkConfig()).
// ---------------------------------------------------------------------------

const admin = require("firebase-admin");
const webpush = require("web-push");

const REMINDER_WINDOW_MS = 60 * 60 * 1000; // avisa lo que vence en la próxima hora

let adminInitialized = false;

function checkConfig() {
  const required = [
    "FIREBASE_SERVICE_ACCOUNT_BASE64",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "VAPID_SUBJECT",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.warn(
      `send-reminders: faltan variables de entorno (${missing.join(", ")}). ` +
        "La función no hará nada hasta que estén configuradas."
    );
    return false;
  }
  return true;
}

function ensureAdminInitialized() {
  if (adminInitialized) return;

  const serviceAccountJson = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    "base64"
  ).toString("utf-8");
  const serviceAccount = JSON.parse(serviceAccountJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  adminInitialized = true;
}

exports.handler = async () => {
  if (!checkConfig()) {
    return { statusCode: 200, body: "Skipped: push no configurado todavía." };
  }

  ensureAdminInitialized();
  const db = admin.firestore();

  const now = Date.now();
  const windowEnd = admin.firestore.Timestamp.fromMillis(now + REMINDER_WINDOW_MS);
  const windowStart = admin.firestore.Timestamp.fromMillis(now);

  let dueItemsSnapshot;
  try {
    // collectionGroup: busca en TODOS los agenda/{uid}/items de todos los
    // usuarios a la vez. Requiere un índice compuesto (ver instrucciones
    // arriba) la primera vez que se ejecuta.
    dueItemsSnapshot = await db
      .collectionGroup("items")
      .where("completed", "==", false)
      .where("notifiedAt", "==", null)
      .where("dueAt", ">=", windowStart)
      .where("dueAt", "<=", windowEnd)
      .get();
  } catch (error) {
    console.error("send-reminders: error consultando la agenda (¿falta el índice compuesto?):", error);
    return { statusCode: 500, body: "Error consultando Firestore. Revisa los logs para el link del índice." };
  }

  if (dueItemsSnapshot.empty) {
    return { statusCode: 200, body: "Sin recordatorios pendientes en esta ventana." };
  }

  let sent = 0;
  let failed = 0;

  for (const itemDoc of dueItemsSnapshot.docs) {
    const item = itemDoc.data();
    const uid = itemDoc.ref.parent.parent.id; // agenda/{uid}/items/{itemId}

    try {
      const subSnap = await db.collection("push_subscriptions").doc(uid).get();
      if (!subSnap.exists) {
        // El usuario nunca activó las notificaciones; marcamos como
        // notificado igual para no reconsultar este ítem en cada corrida.
        await itemDoc.ref.update({ notifiedAt: admin.firestore.FieldValue.serverTimestamp() });
        continue;
      }

      const subscription = subSnap.data();
      const dueDate = item.dueAt.toDate();
      const timeLabel = dueDate.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
      const icon = item.type === "examen" ? "📝" : "📘";

      const payload = JSON.stringify({
        title: `${icon} ${item.title}`,
        body: `Vence hoy a las ${timeLabel}${item.courseName ? ` · ${item.courseName}` : ""}`,
        data: { url: "/index.html" },
      });

      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        payload
      );

      await itemDoc.ref.update({ notifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      sent++;
    } catch (error) {
      failed++;
      // 404/410 = la suscripción ya no es válida (el usuario desinstaló,
      // revocó permisos, etc.) — la borramos para no seguir intentando.
      if (error.statusCode === 404 || error.statusCode === 410) {
        await db.collection("push_subscriptions").doc(uid).delete().catch(() => {});
      } else {
        console.error(`send-reminders: error enviando push a ${uid}:`, error);
      }
    }
  }

  return { statusCode: 200, body: `Enviados: ${sent}. Fallidos: ${failed}.` };
};
