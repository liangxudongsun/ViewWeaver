/**
 * Cocos Creator 资源面板右键菜单注入
 *
 * 这是一个独立的 entry（不是 main.ts），单独被 Cocos 资源面板的渲染进程加载。
 * 通过 `contributions.assets.menu.methods` 注册，cocos 在用户右键资源时会调用
 * 这里导出的函数，函数返回一个 MenuItem[] 数组。
 *
 * 文档：https://docs.cocos.com/creator/3.8/manual/en/editor/assets/extension.html
 */

/// <reference path="../types/editor.d.ts" />

interface AssetMenuInfo {
  uuid: string;
  /** 资源在 db 里的虚拟路径，例如 "db://assets/foo/bar.prefab" */
  url: string;
  /** 资源磁盘绝对路径 */
  file?: string;
  /** 文件后缀名（含点号） */
  extName?: string;
  /** 是否目录 */
  isDirectory?: boolean;
  /** 资源类型，如 "cc.Prefab" */
  type?: string;
  /** importer 名 */
  importer?: string;
}

interface MenuItem {
  label: string;
  enabled?: boolean;
  visible?: boolean;
  submenu?: MenuItem[];
  click?: () => void | Promise<void>;
}

/**
 * 资源右键菜单：作用于单个资源条目
 * 仅 .prefab 才追加 ViewWeaver 子项
 */
export function onAssetMenu(assetInfo: AssetMenuInfo): MenuItem[] {
  if (!assetInfo) return [];
  if (assetInfo.isDirectory) return [];

  const isPrefab =
    assetInfo.type === "cc.Prefab" ||
    assetInfo.extName === ".prefab" ||
    (typeof assetInfo.url === "string" && assetInfo.url.endsWith(".prefab"));
  if (!isPrefab) return [];

  return [
    {
      label: "i18n:viewweaver.menu.generate",
      click(): void {
        // 跨进程发消息到 main.ts 的 generateFromAsset handler
        // 第三个参数是 uuid，main 里 resolveSelectedPrefab 会处理
        Editor.Message.send("viewweaver", "generate-from-asset", assetInfo.uuid);
      },
    },
  ];
}
