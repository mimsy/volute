export function useSavedFeedback() {
  let savedField = $state<string | null>(null);
  let savedTimeout: ReturnType<typeof setTimeout> | null = null;

  function showSaved(field: string) {
    if (savedTimeout) clearTimeout(savedTimeout);
    savedField = field;
    savedTimeout = setTimeout(() => {
      savedField = null;
      savedTimeout = null;
    }, 1500);
  }

  return {
    get savedField() {
      return savedField;
    },
    showSaved,
  };
}
