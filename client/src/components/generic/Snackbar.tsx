import { CloseOutlined as CloseIcon } from "@mui-symbols-material/w400";
import { Button, IconButton, Snackbar } from "@mui/material";
import { filter, noop } from "lodash";
import { Label } from "./Label";
import { useLog } from "slices/log";
import {
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Options = {
  error?: boolean;
  action?: () => void;
  actionLabel?: string;
};

type ClearSnackbarCallback = () => void;

type SnackbarCallback = (
  message?: string,
  secondary?: string,
  options?: Options
) => ClearSnackbarCallback;

const SnackbarContext = createContext<SnackbarCallback>(() => noop);

export interface SnackbarMessage {
  message?: ReactNode;
  action?: () => void;
  actionLabel?: ReactNode;
  key: number;
}

export interface State {
  open: boolean;
  snackPack: readonly SnackbarMessage[];
  messageInfo?: SnackbarMessage;
}

export function useSnackbar() {
  return useContext(SnackbarContext);
}

export function SnackbarProvider({ children }: { children?: ReactNode }) {
  const [snackPack, setSnackPack] = useState<readonly SnackbarMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<SnackbarMessage | undefined>(
    undefined
  );

  const [, appendLog] = useLog();

  useEffect(() => {
    if (snackPack.length && !current) {
      setCurrent({ ...snackPack[0] });
      setSnackPack((prev) => prev.slice(1));
      setOpen(true);
    } else if (snackPack.length && current && open) {
      setOpen(false);
    }
  }, [snackPack, current, open]);

  const handleMessage = useCallback(
    (message?: string, secondary?: string, options: Options = {}) => {
      setSnackPack((prev) => [
        ...prev,
        {
          message: <Label primary={message} secondary={secondary} />,
          action: options.action,
          actionLabel: options.actionLabel,
          key: new Date().getTime(),
        },
      ]);
      appendLog(() => ({
        action: "append",
        log: {
          content: filter([message, secondary]).join(", "),
          timestamp: `${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
        },
      }));
      if (options.error) {
        console.error(`${message}, ${secondary}`);
      }
      return () => handleClose("");
    },
    [setSnackPack]
  );

  const handleClose = (_: unknown, reason?: string) => {
    if (reason !== "clickaway") setOpen(false);
  };

  const handleExited = () => setCurrent(undefined);

  return (
    <>
      <SnackbarContext.Provider value={handleMessage}>
        {children}
      </SnackbarContext.Provider>
      <Snackbar
        sx={{
          "> .MuiPaper-root": {
            bgcolor: "background.paper",
            color: "text.primary",
            overflow: "hidden",
            "& .MuiSnackbarContent-message": {
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "normal",
            },
          },
        }}
        anchorOrigin={{ horizontal: "right", vertical: "bottom" }}
        key={current?.key}
        open={open}
        autoHideDuration={6000}
        onClose={handleClose}
        TransitionProps={{ onExited: handleExited }}
        message={current?.message}
        action={
          <>
            {current?.action && (
              <Button
                variant="text"
                onClick={(e) => {
                  current?.action?.();
                  handleClose?.(e);
                }}
                color="primary"
              >
                {current?.actionLabel}
              </Button>
            )}
            <IconButton
              aria-label="close"
              color="inherit"
              sx={{ p: 0.5 }}
              onClick={handleClose}
            >
              <CloseIcon />
            </IconButton>
          </>
        }
      />
    </>
  );
}
