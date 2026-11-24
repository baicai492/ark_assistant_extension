// 统一配对校验、调动保护和腾房容量使用的居民状态判断。
globalThis.__fengbaoDormResidentState = function createDormResidentState(getView) {
  function hasDormRomance(resident) {
    return Boolean(resident.romance) && getView().state.rooms.some(room =>
      room.id === resident.roomId && room.type === 'quarters');
  }

  function isProtectedAdult(resident, pendingParents) {
    return hasDormRomance(resident) || pendingParents.has(resident.id);
  }

  return { hasDormRomance, isProtectedAdult };
};
