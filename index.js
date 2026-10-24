(function () {
  "use strict";

  /*
   * FollowUser — Revenge / Bunny / Vendetta port
   * Original Vencord plugin by D3SOX (GPL-3.0-or-later)
   *
   * لا يوجد شريط علوي (toolbar) ولا قائمة سياق للمستخدم على الجوال، لذلك:
   *   /follow user:@شخص     ← ابدأ المتابعة
   *   /unfollow             ← أوقف المتابعة
   *   /followtrigger        ← انضم الآن يدوياً إلى روم الشخص المتابَع
   * وكل الإعدادات في صفحة إعدادات الإضافة.
   */

  const { metro, plugin, ui, commands, storage: vstorage } = vendetta;
  const { findByProps, findByStoreName } = metro;
  const { React, ReactNative: RN, FluxDispatcher } = metro.common;
  const storage = plugin.storage;
  const { showToast } = ui.toasts;
  const { getAssetIDByName } = ui.assets;
  const Forms = ui.components.Forms;
  const useProxy = vstorage.useProxy;

  const DEFAULTS = {
    executeOnFollow: true,
    onlyManualTrigger: false,
    followLeave: false,
    autoMoveBack: false,
    channelFull: true,
    followUserId: "",
  };

  // صلاحيات (BigInt بدون literals للتوافق)
  const CONNECT = BigInt(1) << BigInt(20);
  const MOVE_MEMBERS = BigInt(1) << BigInt(24);

  let VoiceStateStore, SelectedChannelStore, ChannelStore, UserStore, PermissionStore, VoiceActions;
  let unregisterCommands = [];
  const lastChannels = {}; // آخر روم معروف لي وللشخص المتابَع

  /* ------------------------------ helpers ------------------------------ */

  function toast(message, ok) {
    try {
      showToast(message, getAssetIDByName(ok ? "Check" : "Small"));
    } catch (e) {
      try { showToast(message); } catch (e2) {}
    }
  }

  function userName(id) {
    try {
      const u = UserStore.getUser(id);
      if (u) return u.globalName || u.username || id;
    } catch (e) {}
    return id;
  }

  function getUserChannelId(userId) {
    if (!userId) return null;
    try {
      if (typeof VoiceStateStore.getVoiceStateForUser === "function") {
        const s = VoiceStateStore.getVoiceStateForUser(userId);
        if (s) return s.channelId || null;
      }
    } catch (e) {}
    try {
      const all = VoiceStateStore.getAllVoiceStates();
      const groups = Object.values(all || {});
      for (let i = 0; i < groups.length; i++) {
        const users = groups[i];
        if (users && users[userId]) return users[userId].channelId || null;
      }
    } catch (e) {}
    return null;
  }

  function memberCount(channelId) {
    try {
      const states = VoiceStateStore.getVoiceStatesForChannel(channelId);
      return states ? Object.keys(states).length : null;
    } catch (e) {
      return null;
    }
  }

  function isFull(channel, channelId) {
    if (!channel || !channel.userLimit) return false;
    const count = memberCount(channelId);
    return count !== null && count >= channel.userLimit && !PermissionStore.can(MOVE_MEMBERS, channel);
  }

  function joinVoice(channelId, channel) {
    if (VoiceActions && typeof VoiceActions.selectVoiceChannel === "function") {
      VoiceActions.selectVoiceChannel(channelId);
      return;
    }
    FluxDispatcher.dispatch({
      type: "VOICE_CHANNEL_SELECT",
      guildId: channel ? channel.guild_id || null : null,
      channelId: channelId,
    });
  }

  function leaveVoice() {
    if (VoiceActions && typeof VoiceActions.disconnect === "function") {
      VoiceActions.disconnect();
      return;
    }
    FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_SELECT", guildId: null, channelId: null });
  }

  /* ------------------------------ core logic ------------------------------ */

  // manual = true عند الضغط اليدوي (يعرض رسائل أكثر)
  function triggerFollow(userChannelId, manual) {
    if (!storage.followUserId) return;
    if (userChannelId === undefined) userChannelId = getUserChannelId(storage.followUserId);

    const myChanId = SelectedChannelStore.getVoiceChannelId();

    if (userChannelId) {
      if (userChannelId === myChanId) {
        if (manual) toast("أنت بالفعل في نفس الروم", false);
        return;
      }
      const channel = ChannelStore.getChannel(userChannelId);
      if (!channel) {
        toast("تعذّر العثور على الروم", false);
        return;
      }
      const isDM = channel.type === 1 || channel.type === 3;
      if (!isDM && !PermissionStore.can(CONNECT, channel)) {
        toast("ليس لديك صلاحية دخول هذا الروم الصوتي", false);
        return;
      }
      if (!isDM && isFull(channel, userChannelId)) {
        toast("الروم ممتلئ", false);
        return;
      }
      joinVoice(userChannelId, channel);
      toast("تم الانضمام لروم " + userName(storage.followUserId), true);
    } else if (myChanId) {
      if (storage.followLeave) {
        leaveVoice();
        toast("غادر المستخدم، تم قطع الاتصال", true);
      } else if (manual) {
        toast("غادر المستخدم، لكن خيار المغادرة التلقائية متوقف", false);
      }
    } else if (manual) {
      toast("المستخدم المتابَع ليس في روم صوتي", false);
    }
  }

  function setFollow(userId) {
    storage.followUserId = userId;
    if (userId && storage.executeOnFollow) triggerFollow(undefined, true);
  }

  function onVoiceStateUpdates(payload) {
    const voiceStates = payload && payload.voiceStates;
    if (!voiceStates) return;

    let myId;
    try { myId = UserStore.getCurrentUser().id; } catch (e) { return; }
    const followId = storage.followUserId;

    for (let i = 0; i < voiceStates.length; i++) {
      const vs = voiceStates[i];
      const userId = vs.userId;
      const channelId = vs.channelId || null;
      const oldChannelId = vs.oldChannelId || lastChannels[userId] || null;

      if (userId === myId || (followId && userId === followId)) lastChannels[userId] = channelId;

      if (storage.onlyManualTrigger || !followId) continue;
      if (channelId === oldChannelId) continue;

      const isMe = userId === myId;

      // نُقلت من روم المتابَع → ارجع
      if (storage.autoMoveBack && isMe && channelId && oldChannelId) {
        const target = getUserChannelId(followId);
        if (target && target !== channelId) triggerFollow(target, false);
        continue;
      }

      // الروم كان ممتلئاً وخرج أحدهم → حاول الدخول
      if (
        storage.channelFull && !isMe && !channelId && oldChannelId &&
        oldChannelId !== SelectedChannelStore.getVoiceChannelId()
      ) {
        const channel = ChannelStore.getChannel(oldChannelId);
        const states = VoiceStateStore.getVoiceStatesForChannel(oldChannelId);
        const count = states ? Object.keys(states).length : null;
        if (
          channel && channel.userLimit && count !== null &&
          count === channel.userLimit - 1 && !PermissionStore.can(MOVE_MEMBERS, channel)
        ) {
          const ids = Object.values(states).map(function (x) { return x.userId; });
          if (ids.indexOf(followId) !== -1) {
            triggerFollow(oldChannelId, false);
            continue;
          }
        }
      }

      if (userId !== followId) continue;

      if (channelId) triggerFollow(channelId, false); // دخل/انتقل
      else if (oldChannelId) triggerFollow(null, false); // غادر
    }
  }

  /* ------------------------------ commands ------------------------------ */

  function opt(name, description, type, required) {
    return {
      name: name, displayName: name,
      description: description, displayDescription: description,
      type: type, required: !!required,
    };
  }

  function cmd(name, description, options, execute) {
    return {
      name: name, displayName: name,
      description: description, displayDescription: description,
      options: options || [],
      applicationId: "-1", inputType: 1, type: 1,
      execute: execute,
    };
  }

  function registerAll() {
    const reg = commands.registerCommand;

    unregisterCommands.push(reg(cmd(
      "follow", "تابع مستخدماً في الرومات الصوتية",
      [opt("user", "المستخدم المراد متابعته", 6, true)],
      function (args) {
        const id = args && args[0] && args[0].value;
        if (!id) return toast("اختر مستخدماً", false);
        if (id === UserStore.getCurrentUser().id) return toast("لا يمكنك متابعة نفسك", false);
        setFollow(id);
        toast("تتابع الآن: " + userName(id), true);
      }
    )));

    unregisterCommands.push(reg(cmd(
      "unfollow", "أوقف متابعة المستخدم",
      [],
      function () {
        if (!storage.followUserId) return toast("لا تتابع أحداً", false);
        storage.followUserId = "";
        toast("تم إيقاف المتابعة", true);
      }
    )));

    unregisterCommands.push(reg(cmd(
      "followtrigger", "انضم الآن إلى روم المستخدم المتابَع",
      [],
      function () {
        if (!storage.followUserId) return toast("لا تتابع أحداً", false);
        triggerFollow(undefined, true);
      }
    )));
  }

  /* ------------------------------ settings UI ------------------------------ */

  function SwitchRow(props) {
    if (Forms.FormSwitchRow) return React.createElement(Forms.FormSwitchRow, props);
    return React.createElement(Forms.FormRow, {
      label: props.label,
      subLabel: props.subLabel,
      trailing: React.createElement(Forms.FormSwitch, {
        value: props.value, onValueChange: props.onValueChange,
      }),
    });
  }

  function Settings() {
    useProxy(storage);
    const h = React.createElement;

    function sw(key, label, sub) {
      return h(SwitchRow, {
        key: key, label: label, subLabel: sub,
        value: !!storage[key],
        onValueChange: function (v) { storage[key] = v; },
      });
    }

    const followed = storage.followUserId;

    return h(RN.ScrollView, null,
      h(Forms.FormSection, { title: "المتابعة الحالية" },
        h(Forms.FormInput, {
          title: "ID المستخدم المتابَع",
          placeholder: "مثال: 123456789012345678",
          value: followed,
          onChange: function (v) { storage.followUserId = String(v || "").trim(); },
          keyboardType: "numeric",
        }),
        followed ? h(Forms.FormRow, {
          label: "المتابَع: " + userName(followed),
          subLabel: "اضغط للانضمام الآن يدوياً",
          onPress: function () { triggerFollow(undefined, true); },
        }) : null,
        followed ? h(Forms.FormRow, {
          label: "إيقاف المتابعة",
          onPress: function () { storage.followUserId = ""; toast("تم إيقاف المتابعة", true); },
        }) : null
      ),
      h(Forms.FormSection, { title: "الخيارات" },
        sw("executeOnFollow", "انضم فوراً عند بدء المتابعة", "تأكد أنك في نفس الروم لحظة المتابعة"),
        sw("onlyManualTrigger", "يدوي فقط", "لا تنضم تلقائياً — فقط عبر /followtrigger أو الضغط في الإعدادات"),
        sw("followLeave", "غادر عندما يغادر", "اقطع الاتصال عند مغادرة المستخدم المتابَع"),
        sw("autoMoveBack", "ارجع تلقائياً إذا نُقلت", "عد إلى روم المتابَع إذا تم نقلك لروم آخر"),
        sw("channelFull", "حاول الدخول عند خلو مكان", "إذا كان الروم ممتلئاً، انضم عندما يتوفر مكان")
      )
    );
  }

  /* ------------------------------ lifecycle ------------------------------ */

  return {
    onLoad: function () {
      Object.keys(DEFAULTS).forEach(function (k) {
        if (storage[k] === undefined) storage[k] = DEFAULTS[k];
      });

      VoiceStateStore = findByStoreName("VoiceStateStore");
      SelectedChannelStore = findByStoreName("SelectedChannelStore");
      ChannelStore = findByStoreName("ChannelStore");
      UserStore = findByStoreName("UserStore");
      PermissionStore = findByStoreName("PermissionStore");
      VoiceActions = findByProps("selectVoiceChannel", "disconnect") || findByProps("selectVoiceChannel");

      FluxDispatcher.subscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates);
      registerAll();
    },

    onUnload: function () {
      try { FluxDispatcher.unsubscribe("VOICE_STATE_UPDATES", onVoiceStateUpdates); } catch (e) {}
      unregisterCommands.forEach(function (u) { try { u(); } catch (e) {} });
      unregisterCommands = [];
    },

    settings: Settings,
  };
})()
