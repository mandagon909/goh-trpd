/* «Царь Горы» — экран входа и регистрации по почте и паролю (+ Discord, если включён). */
(function () {
  const CFG = window.GOH_CONFIG || {};
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  let mode = "login";

  window.renderAuth = function (m) {
    if (m) mode = m;
    const app = document.getElementById("app");
    const sb = window.GOH_SB;
    if (!window.GOH_READY || !sb) {
      app.innerHTML = `<div class="regwrap"><div class="panel"><h2>Сайт ещё не подключён к базе</h2><p style="margin:0">Открой файл <b>app/config.js</b> и вставь адрес и ключ проекта Supabase (см. README).</p></div></div>`;
      return;
    }
    const T = (k, n) => `<button type="button" data-am="${k}" aria-pressed="${mode === k}">${n}</button>`;
    const title = { login: "ВХОД", signup: "РЕГИСТРАЦИЯ", reset: "ВОССТАНОВЛЕНИЕ", recover: "НОВЫЙ ПАРОЛЬ" }[mode];
    app.innerHTML = `<div class="regwrap"><div class="regart" id="authart"></div>
     <form class="panel" id="authform" autocomplete="on" novalidate>
      <div><span class="eyebrow">Аккаунт игрока</span><h1 style="font-size:clamp(26px,4vw,38px)">${title}</h1></div>
      ${mode === "login" || mode === "signup" ? `<div class="tabs2" style="margin:0">${T("login", "Вход")}${T("signup", "Регистрация")}</div>` : ""}
      ${mode !== "recover" ? `<div class="field"><label for="a-email">Почта</label><input class="input" id="a-email" type="email" autocomplete="email" maxlength="120" required></div>` : ""}
      ${mode !== "reset" ? `<div class="field"><label for="a-pass">${mode === "recover" ? "Новый пароль" : "Пароль"}</label><input class="input" id="a-pass" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="6" maxlength="72" required></div>` : ""}
      ${mode === "signup" || mode === "recover" ? `<div class="field"><label for="a-pass2">Повтори пароль</label><input class="input" id="a-pass2" type="password" autocomplete="new-password" maxlength="72" required></div>` : ""}
      <div class="savebar"><button class="btn primary" type="submit">${{ login: "Войти", signup: "Создать аккаунт", reset: "Прислать ссылку", recover: "Сохранить пароль" }[mode]}</button>
       ${mode === "login" ? `<button class="linkbtn" type="button" data-am="reset" style="font-size:13px">Забыл пароль</button>` : ""}
       ${mode === "reset" ? `<button class="linkbtn" type="button" data-am="login" style="font-size:13px">← Ко входу</button>` : ""}</div>
      ${CFG.DISCORD_LOGIN && (mode === "login" || mode === "signup") ? `<button class="btn" type="button" id="a-discord" style="background:#5865F2;color:#fff;justify-content:center">Войти через Discord</button>` : ""}
      <span class="toast" id="a-t" role="status"></span>
      <p class="muted" style="margin:0;font-size:12.5px">Пароль хранится в зашифрованном виде у Supabase, сайт его не видит. После входа укажешь ник в Discord.</p>
     </form></div>`;
    try { const p = (window.pool && window.pool()) || []; const a = document.getElementById("authart"); if (a && window.slot) a.innerHTML = window.slot("reg", 5, 11, "ВХОД!"); } catch (e) {}
    app.querySelectorAll("[data-am]").forEach((b) => (b.onclick = () => window.renderAuth(b.dataset.am)));
    const say = (m, ok) => { const t = document.getElementById("a-t"); t.className = "toast " + (ok ? "ok" : "err"); t.textContent = m; };
    const dz = document.getElementById("a-discord");
    if (dz) dz.onclick = async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: "discord", options: { redirectTo: location.origin + location.pathname } });
      if (error) say("Вход через Discord не настроен. Попроси ГМа включить его в Supabase.");
    };
    document.getElementById("authform").onsubmit = async (e) => {
      e.preventDefault();
      const v = (id) => { const x = document.getElementById(id); return x ? x.value.trim() : ""; };
      const email = v("a-email"), pass = v("a-pass"), pass2 = v("a-pass2");
      if (mode !== "recover" && !/^\S+@\S+\.\S+$/.test(email)) return say("Укажи почту.");
      if (mode !== "reset" && pass.length < 6) return say("Пароль: минимум 6 символов.");
      if ((mode === "signup" || mode === "recover") && pass !== pass2) return say("Пароли не совпадают.");
      say("…", true);
      const rus = (m) => /Invalid login/i.test(m) ? "Неверная почта или пароль." : /already registered|already exists/i.test(m) ? "Такая почта уже зарегистрирована. Нажми «Вход»." : /Email not confirmed/i.test(m) ? "Почта не подтверждена. Открой письмо от Supabase." : /rate limit|too many/i.test(m) ? "Слишком много попыток. Подожди немного." : m;
      if (mode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password: pass });
        if (error) return say(rus(error.message));
        location.hash = ""; location.reload();
      } else if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password: pass, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) return say(rus(error.message));
        if (data.session) { location.hash = ""; location.reload(); }
        else say("Готово! Мы отправили письмо на " + email + ". Открой его и подтверди почту, потом войди.", true);
      } else if (mode === "reset") {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
        if (error) return say(rus(error.message));
        say("Если такая почта есть, мы отправили на неё ссылку для смены пароля.", true);
      } else if (mode === "recover") {
        const { error } = await sb.auth.updateUser({ password: pass });
        if (error) return say(rus(error.message));
        window.GOH_RECOVERY = false; say("Пароль изменён.", true); setTimeout(() => location.reload(), 900);
      }
    };
  };

  window.gohLogout = async function () { try { await window.GOH_SB.auth.signOut(); } catch (e) {} location.reload(); };
})();
