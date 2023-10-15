export function removeDuplicateObjects<
  T extends Record<string, any>,
  K extends keyof T
>(array: Array<T>, property: K) {
  const uniqueIds: K[] = [];

  const unique = array.filter((element) => {
    const isDuplicate = uniqueIds.includes(element[property]);

    if (!isDuplicate) {
      uniqueIds.push(element[property]);

      return true;
    }

    return false;
  });

  return unique;
}
