/**
 * Cocos Creator 3.8 Editor API 最小化类型声明
 *
 * 只覆盖 ViewWeaver 实际用到的接口；完整类型见 @cocos/creator-types
 * 当用户在他们的开发机上 `npm install --save-dev @cocos/creator-types` 后会被覆盖。
 */

declare namespace Editor {
  /** 项目级信息 */
  namespace Project {
    /** 当前 Cocos 项目根目录绝对路径（不含末尾分隔符） */
    const path: string;
    /** 当前项目名称（package.json#name） */
    const name: string;
    /** 项目使用的 UUID */
    const uuid: string;
  }

  /** 当前编辑器版本号（如 "3.8.2"） */
  namespace App {
    const version: string;
  }

  /** 用于跨进程通信 */
  namespace Message {
    /**
     * 请求-响应模式（拿到返回值）
     * @param target 目标插件名，如 "asset-db"
     * @param messageName 消息名，如 "query-asset-info"
     */
    function request<T = unknown>(target: string, messageName: string, ...args: unknown[]): Promise<T>;
    /** 广播（无返回值） */
    function broadcast(messageName: string, ...args: unknown[]): void;
    /** 直接 send（一般是发给自身扩展） */
    function send(target: string, messageName: string, ...args: unknown[]): void;
  }

  /** 当前在某种面板里被选中的项目（资源 UUID 等） */
  namespace Selection {
    /**
     * 取得最近一次选中类型对应的项目集合
     * type 通常是 "asset" / "node"
     */
    function getSelected(type: string): string[];
    /** 当前最近一次选中的某个项 */
    function getLastSelected(type: string): string | null;
    /** 选中指定 uuid（type: "asset"/"node"） */
    function select(type: string, uuid: string | string[]): void;
  }

  /** 通知 / Toast */
  namespace Dialog {
    interface MessageOptions {
      title?: string;
      message?: string;
      detail?: string;
      buttons?: string[];
      type?: "info" | "warning" | "error" | "question";
      default?: number;
    }
    function info(message: string, opts?: MessageOptions): Promise<{ response: number }>;
    function warn(message: string, opts?: MessageOptions): Promise<{ response: number }>;
    function error(message: string, opts?: MessageOptions): Promise<{ response: number }>;
  }

  // 注意：Cocos Creator 3.8 的 Editor 命名空间下并没有稳定的 Logger 子命名空间。
  // 不同版本里 Logger 的存在性 / 形态都不一样：
  //   - 3.8.8（实测）：访问 Editor.Logger.info → TypeError
  //   - 部分 3.7 内部构建：曾出现过 Editor.Logger.log
  // 业内通行做法是直接用 console.{log|warn|error}，Cocos 控制台会捕获并按级别染色。
  // 因此 ViewWeaver 不再依赖 Editor.Logger，统一通过 main.ts 内部的 log helper 走 console。

  /** 面板：在编辑器里开/关 panel；并提供 panel 定义 API
   *
   * panel-id 形如 "<extension-name>" 或 "<extension-name>.<panel-name>"
   * panel 的 methods 内 this 会被 cocos 绑定到 panel 实例（含 $ 引用映射）。
   * 这里类型放宽到 unknown / any，避免和具体 panel 定义里五花八门的方法签名冲突。
   */
  namespace Panel {
    function open(name: string, ...args: unknown[]): Promise<void>;
    function close(name: string): Promise<void>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function define(options: any): any;
  }
}

/** asset-db 查询返回值（最小子集） */
declare interface AssetInfo {
  /** 资源 UUID */
  uuid: string;
  /** 资源相对项目根的 db 路径，如 "db://assets/foo.prefab" */
  url: string;
  /** 文件绝对路径 */
  file: string;
  /** 资源后缀，如 ".prefab" */
  extName?: string;
  /** 资源类型，如 "cc.Prefab" */
  type?: string;
  /** 是否目录 */
  isDirectory?: boolean;
  /** import 信息（meta） */
  importer?: string;
  /** 资源类型的 i18n 名 */
  source?: string;
}
