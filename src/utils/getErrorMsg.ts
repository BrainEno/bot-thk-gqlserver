export type ErrorWithMessage = {
  message: string;
};

function isErrorMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

function toErrorWithMessage(maybeError: unknown): ErrorWithMessage {
  if (isErrorMessage(maybeError)) {
    return maybeError;
  }
  try {
    return new Error(JSON.stringify(maybeError));
  } catch (error) {
    return new Error(String(maybeError));
  }
}

export const getErrorMsg = (error: unknown) => {
  return toErrorWithMessage(error).message;
};
