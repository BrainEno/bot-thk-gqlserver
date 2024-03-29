const convertToStr = (str: string) =>
  str.replace(/<[^>]*>/g, " ").replace(/(&nbsp;)+/g, " ");

export const isHanReg = (str: string) => /[\u4e00-\u9fa5]/.test(str);

export const smartTrim = (
  str: string,
  length: number,
  delim: string,
  appendix: string
): string => {
  str = convertToStr(str).trim();

  const isHan = isHanReg(str);

  console.log("isHan", isHan);

  if (str.length <= length) return str;

  let trimmedStr = isHan
    ? str.substring(0, length + delim.length)
    : str.substring(0, length * 2 + delim.length);

  const lastDelimIndex = trimmedStr.lastIndexOf(delim);
  if (lastDelimIndex >= 0) {
    trimmedStr = trimmedStr.substring(0, lastDelimIndex);
  }

  if (trimmedStr) {
    trimmedStr += appendix;
  }
  return trimmedStr;
};
